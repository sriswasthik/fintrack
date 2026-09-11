/**
 * Turning a PDF statement back into rows.
 *
 * A statement is a table, but a PDF does not know that: it knows where each run
 * of text was drawn. So the structure has to be recovered from geometry —
 * rows from the y coordinate, columns from the x — and that recovery either
 * works confidently or it does not. When it does not, the caller falls back to
 * asking a model (services/ai/statement.ts) rather than guessing, because a
 * misread statement is worse than an unread one.
 *
 * Everything downstream of the rows produced here is the Phase 2-3 pipeline
 * unchanged: the same `ParsedRow` shape, the same merchant normalization, the
 * same duplicate flagging, the same rule engine.
 */
import { extractMerchant } from './normalize';
import { parseAmount, type ParsedRow, type RowError } from './csv';
import type { PdfPage, PdfTextItem, TextItemsByPage } from './pdf';

/** Items drawn within this many points of each other are on the same line. */
const LINE_TOLERANCE = 2.5;

/** A horizontal gap wider than this separates one column from the next. */
const COLUMN_GAP = 5;

/** The share of candidate lines that must parse before we trust the result. */
const CONFIDENCE_THRESHOLD = 0.6;

export interface StatementLine {
  /** Points from the bottom of the page. */
  y: number;
  /** Left to right. */
  items: PdfTextItem[];
  text: string;
}

/** A vertical band of the page that one column's text occupies. */
export interface ColumnBand {
  from: number;
  to: number;
}

/** The columns a generic tabular statement carries, in order. */
export const GENERIC_HEADERS = [
  'date',
  'narration',
  'reference',
  'debit',
  'credit',
  'balance',
] as const;

export type GenericHeader = (typeof GENERIC_HEADERS)[number];

/** What a header cell might be called on a real statement. */
const HEADER_PATTERNS: Record<GenericHeader, RegExp> = {
  date: /^(txn|tran|transaction|value|post(ing)?)?\s*date$/i,
  narration: /^(narration|particulars|description|details|transaction\s*details)$/i,
  reference: /^(reference|reference\s*no\.?|ref\.?\s*no\.?|cheque\s*no\.?|chq\.?\s*no\.?)$/i,
  debit: /^(debits?|withdrawals?(\s*(amt\.?|amount|\(dr\)))?|dr)$/i,
  credit: /^(credits?|deposits?(\s*(amt\.?|amount|\(cr\)))?|cr)$/i,
  balance: /^(balance|closing\s*balance)$/i,
};

/** Groups a page's text runs into lines by their y coordinate. */
export function groupIntoLines(page: PdfPage, tolerance = LINE_TOLERANCE): StatementLine[] {
  const lines: StatementLine[] = [];

  // Top of the page downwards, which is descending y in PDF coordinates.
  for (const item of [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item], text: '' });
  }

  return lines.map((line) => {
    const items = line.items.sort((a, b) => a.x - b.x);
    return { ...line, items, text: items.map((i) => i.text).join(' ') };
  });
}

/**
 * The line that names the columns, if there is one.
 *
 * Requires a date column and at least one money column: a line saying "Date"
 * and nothing else is a heading, not a table header.
 */
export function findHeaderLine(lines: StatementLine[]): StatementLine | null {
  for (const line of lines) {
    const matched = new Set<GenericHeader>();
    for (const item of line.items) {
      for (const header of GENERIC_HEADERS) {
        if (HEADER_PATTERNS[header].test(item.text.trim())) matched.add(header);
      }
    }
    const hasMoney = matched.has('debit') || matched.has('credit') || matched.has('balance');
    if (matched.has('date') && hasMoney && matched.size >= 3) return line;
  }
  return null;
}

/**
 * The vertical bands the table's text occupies, found from gaps.
 *
 * Deliberately computed across every data line rather than from the header
 * positions: a header is centred over its column but the figures under it are
 * right-aligned against the far edge, so header x tells you almost nothing
 * about where the numbers sit. What is reliable is that no text crosses the
 * whitespace between two columns.
 */
export function findColumnBands(lines: StatementLine[], gap = COLUMN_GAP): ColumnBand[] {
  const spans = lines
    .flatMap((line) => line.items)
    .map((item) => ({ from: item.x, to: item.x + item.width }))
    .sort((a, b) => a.from - b.from);

  const bands: ColumnBand[] = [];
  for (const span of spans) {
    const last = bands[bands.length - 1];
    if (last && span.from <= last.to + gap) last.to = Math.max(last.to, span.to);
    else bands.push({ ...span });
  }
  return bands;
}

/** Which band an item sits in, by overlap. */
function bandOf(item: PdfTextItem, bands: ColumnBand[]): number {
  const from = item.x;
  const to = item.x + item.width;
  let best = -1;
  let bestOverlap = 0;
  bands.forEach((band, index) => {
    const overlap = Math.min(to, band.to) - Math.max(from, band.from);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = index;
    }
  });
  return best;
}

/**
 * Names each band from the header line sitting above it.
 *
 * Returns null unless every column the reference layout needs was found. A
 * partial match is not a near miss to be patched up — it means this is not the
 * layout, and something else should read the file.
 */
export function nameBands(
  header: StatementLine,
  bands: ColumnBand[],
): Partial<Record<GenericHeader, number>> | null {
  const named: Partial<Record<GenericHeader, number>> = {};

  for (const item of header.items) {
    const text = item.text.trim();
    for (const name of GENERIC_HEADERS) {
      if (!HEADER_PATTERNS[name].test(text)) continue;
      const index = bandOf(item, bands);
      if (index >= 0) named[name] = index;
    }
  }

  // A multi-word header ("Reference No") arrives as one run or two; either way
  // the date and the money columns are what the parse actually depends on.
  const required: GenericHeader[] = ['date', 'narration', 'debit', 'credit'];
  return required.every((name) => named[name] !== undefined) ? named : null;
}

/** One line's cells, keyed by column name. */
function cellsOf(
  line: StatementLine,
  bands: ColumnBand[],
  named: Partial<Record<GenericHeader, number>>,
): Partial<Record<GenericHeader, string>> {
  const byBand = new Map<number, string[]>();
  for (const item of line.items) {
    const index = bandOf(item, bands);
    if (index < 0) continue;
    byBand.set(index, [...(byBand.get(index) ?? []), item.text]);
  }

  const cells: Partial<Record<GenericHeader, string>> = {};
  for (const name of GENERIC_HEADERS) {
    const index = named[name];
    if (index === undefined) continue;
    const parts = byBand.get(index);
    if (parts) cells[name] = parts.join(' ').trim();
  }
  return cells;
}

/**
 * A statement date, which is `dd/mm/yyyy` far more often than not.
 *
 * The CSV path reads `03/05/2026` as March 5th, because that is what a US
 * export means by it. A statement from an Indian bank means May 3rd. Rather
 * than pick one and be quietly wrong half the time, the convention is settled
 * from the file: any day-position value above 12 proves which way round it is,
 * and a statement covering a month almost always contains one.
 */
export function detectDateOrder(values: string[]): 'dmy' | 'mdy' {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const value of values) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(value.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (firstOver12 && !secondOver12) return 'dmy';
  if (secondOver12 && !firstOver12) return 'mdy';
  // Nothing in the file settles it; a statement is dd/mm/yyyy by default.
  return 'dmy';
}

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

/** A statement date in any of the shapes a bank prints, as ISO. */
export function parseStatementDate(value: string, order: 'dmy' | 'mdy' = 'dmy'): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 15-Mar-2026 and 15 Mar 2026, both common on Indian statements.
  const named = /^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2}|\d{4})$/.exec(trimmed);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
    const year = Number(named[3]);
    return toIso(year < 100 ? 2000 + year : year, month, Number(named[1]));
  }

  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(trimmed);
  if (numeric) {
    const year = Number(numeric[3]);
    const [day, month] =
      order === 'dmy'
        ? [Number(numeric[1]), Number(numeric[2])]
        : [Number(numeric[2]), Number(numeric[1])];
    return toIso(year < 100 ? 2000 + year : year, month, day);
  }

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export interface StatementParseResult {
  rows: ParsedRow[];
  errors: RowError[];
  /** Share of candidate lines that produced a row. */
  confidence: number;
}

/**
 * Reads a generic tabular statement: Date | Narration | Reference | Debit |
 * Credit | Balance.
 *
 * Returns null when the layout is not this one, or when too few lines parsed to
 * trust what came out. Both are the signal to fall back rather than to ship a
 * half-read statement.
 */
export function parseGenericStatement(pages: TextItemsByPage): StatementParseResult | null {
  const allLines = pages.flatMap((page) => groupIntoLines(page));
  const header = findHeaderLine(allLines);
  if (!header) return null;

  // Bands are measured from the rows, not the headings above them.
  const belowHeader = allLines.filter((line) => line.y < header.y - LINE_TOLERANCE);
  const bands = findColumnBands([header, ...belowHeader]);
  const named = nameBands(header, bands);
  if (!named) return null;

  const dateBand = named.date!;
  const candidates = belowHeader.filter((line) =>
    line.items.some((item) => bandOf(item, bands) === dateBand && /\d/.test(item.text)),
  );
  if (candidates.length === 0) return null;

  const order = detectDateOrder(
    candidates.flatMap((line) =>
      line.items.filter((i) => bandOf(i, bands) === dateBand).map((i) => i.text),
    ),
  );

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];

  candidates.forEach((line, i) => {
    const index = i + 1;
    const cells = cellsOf(line, bands, named);
    const values = Object.fromEntries(
      Object.entries(cells).map(([k, v]) => [k, v ?? '']),
    ) as Record<string, string>;

    const date = parseStatementDate(cells.date ?? '', order);
    if (!date) {
      errors.push({ index, reason: `Unrecognised date: "${cells.date ?? ''}"`, values });
      return;
    }

    const description = (cells.narration ?? '').trim();
    if (!description) {
      errors.push({ index, reason: 'Missing description', values });
      return;
    }

    const debit = parseAmount(cells.debit ?? '');
    const credit = parseAmount(cells.credit ?? '');
    if (debit === null && credit === null) {
      errors.push({ index, reason: 'Row has neither a debit nor a credit', values });
      return;
    }
    if (debit !== null && credit !== null) {
      errors.push({ index, reason: 'Row has both a debit and a credit', values });
      return;
    }

    const { rawMerchant, normalizedMerchant } = extractMerchant(description);

    rows.push({
      index,
      date,
      postedDate: null,
      description,
      rawMerchant,
      normalizedMerchant,
      // Debit-positive, the convention every other source is normalized onto.
      amount: debit !== null ? debit : -credit!,
    });
  });

  const confidence = rows.length / candidates.length;
  return confidence >= CONFIDENCE_THRESHOLD ? { rows, errors, confidence } : null;
}

/** The whole document as plain text, for the model fallback to read. */
export function toPlainText(pages: TextItemsByPage): string {
  return pages
    .map((page) => groupIntoLines(page).map((line) => line.text).join('\n'))
    .join('\n\n');
}
