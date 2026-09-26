/**
 * Server-side CSV parsing.
 *
 * Everything about interpreting a bank export lives here: which columns mean
 * what, how each institution signs its amounts, and how dates and money are
 * spelled. The client never parses anything — it uploads bytes and renders
 * whatever this returns (PROJECT_CONTEXT.md §4).
 *
 * Two shapes of export are read:
 *
 *   * **One signed amount column** — the US card exports (Chase, Amex) and the
 *     generic `date,description,amount`, optionally with a Dr/Cr column or a
 *     Cr/Dr suffix on the figure saying which way the money went.
 *   * **Separate debit and credit columns** — what Indian banks export:
 *     `Withdrawal Amt.` / `Deposit Amt.`, `Debit` / `Credit`, `DR` / `CR`.
 *
 * Indian exports also open with several lines of account details above the
 * real header, so the header is found rather than assumed to be line one.
 */
import Papa from 'papaparse';

import {
  detectDateOrderFrom,
  parseStatementDate,
  type DateOrder,
  type DateOrderBasis,
} from './dates';
import { extractMerchant } from './normalize';

/**
 * How an export signs its amounts.
 *
 * FinTrack stores amounts debit-positive (a purchase is positive, a refund or
 * deposit is negative — see prisma/schema.prisma). Chase-style exports do the
 * opposite, so their amounts are negated on the way in.
 */
export type AmountSign = 'debit-positive' | 'credit-positive';

export interface ColumnMapping {
  date: string;
  description: string;
  /** One signed amount column. Either this, or `debit` and/or `credit`. */
  amount?: string;
  /** Money out, as a positive figure. */
  debit?: string;
  /** Money in, as a positive figure. */
  credit?: string;
  /**
   * With `amount`: a column saying which way the money went (`Dr`/`Cr`,
   * `Debit`/`Credit`). Where it answers, it wins over `amountSign`.
   */
  drCr?: string;
  postedDate?: string;
  /** How `amount` is signed. Ignored for debit/credit columns. */
  amountSign: AmountSign;
  /**
   * How numeric dates are written. Absent means settle it from the file, which
   * is right whenever any date in it has a day above 12.
   */
  dateOrder?: DateOrder;
}

export type PresetId = 'generic' | 'chase' | 'amex' | 'debit-credit';

export interface HeaderPreset {
  id: PresetId;
  label: string;
  /** Every one of these must be present for the preset to match. */
  required: string[];
  mapping: ColumnMapping;
}

export const HEADER_PRESETS: HeaderPreset[] = [
  {
    id: 'chase',
    label: 'Chase (credit card export)',
    required: ['transaction date', 'post date', 'description', 'amount'],
    mapping: {
      date: 'Transaction Date',
      postedDate: 'Post Date',
      description: 'Description',
      amount: 'Amount',
      // Chase writes purchases as negative numbers.
      amountSign: 'credit-positive',
      dateOrder: 'mdy',
    },
  },
  {
    id: 'amex',
    label: 'American Express export',
    required: ['date', 'description', 'card member', 'amount'],
    mapping: {
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
      // Amex writes charges as positive numbers.
      amountSign: 'debit-positive',
      dateOrder: 'mdy',
    },
  },
  {
    id: 'generic',
    label: 'Generic (date, description, amount)',
    required: ['date', 'description', 'amount'],
    mapping: {
      date: 'date',
      description: 'description',
      amount: 'amount',
      amountSign: 'debit-positive',
    },
  },
];

export interface ParsedRow {
  /** 1-based data row number, matching the row numbers in test-data/README.md. */
  index: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  postedDate: string | null;
  description: string;
  rawMerchant: string;
  normalizedMerchant: string;
  /** Debit-positive, whatever the source convention was. */
  amount: number;
}

export interface RowError {
  index: number;
  reason: string;
  values: Record<string, string>;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];
  /**
   * How numeric dates were read. `basis: 'default'` means nothing in the file
   * proved it either way and dd/mm was assumed — the preview says so, because
   * a wrong answer there moves every date without failing a single row.
   */
  dateOrder: { order: DateOrder; basis: DateOrderBasis };
}

/** Case- and whitespace-insensitive header comparison. */
function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A header reduced to its words, for recognising what a column holds:
 * `Withdrawal Amt.` and `Withdrawal Amount (INR )` both become
 * `withdrawal amt`/`withdrawal amount`.
 */
function headerWords(header: string): string {
  return headerKey(header)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[.:#*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a column is called on real exports, by the field it fills. */
const FIELD_PATTERNS = {
  txnDate: /^(txn|tran|trans|transaction) ?(date|dt)$/,
  date: /^(date|dt)$/,
  postingDate: /^(post|posted|posting|booking) ?(date|dt)?$/,
  valueDate: /^value ?(date|dt)$/,
  description:
    /^(narration|particulars|description|details|remarks|transaction (details|remarks|description|particulars)|merchant( name)?|payee)$/,
  amount: /^(amount|amt|transaction amount|txn amount)$/,
  debit:
    /^(debits?|dr|withdrawals?|withdrawal (amt|amount)|debit (amt|amount)|paid out|money out)$/,
  credit: /^(credits?|cr|deposits?|deposit (amt|amount)|credit (amt|amount)|paid in|money in)$/,
  drCr: /^(dr ?\/ ?cr|cr ?\/ ?dr|debit ?\/ ?credit|type|transaction type|txn type)$/,
} as const;

type Field = keyof typeof FIELD_PATTERNS;

function findColumn(headers: string[], field: Field): string | undefined {
  return headers.find((h) => FIELD_PATTERNS[field].test(headerWords(h)));
}

/** Does this line name the columns of a transaction table? */
function looksLikeHeader(cells: string[]): boolean {
  const words = cells.map(headerWords).filter(Boolean);
  const has = (...fields: Field[]) =>
    words.some((w) => fields.some((field) => FIELD_PATTERNS[field].test(w)));
  return (
    words.length >= 3 &&
    has('txnDate', 'date', 'postingDate', 'valueDate') &&
    has('amount', 'debit', 'credit')
  );
}

/** How far down a file to look for the header before giving up. */
const HEADER_SEARCH_LINES = 40;

/**
 * The file from its header line onwards.
 *
 * Indian bank exports put the account holder, the account number and the
 * statement period above the table, so taking line one as the header yields a
 * mapping screen full of someone's address. The first line that names a date
 * column and a money column is the header; when no line does, the file is
 * returned as it came and line one is the header, as before.
 */
export function fromHeaderLine(csvText: string): string {
  const text = csvText.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const limit = Math.min(lines.length, HEADER_SEARCH_LINES);
  for (let i = 0; i < limit; i++) {
    if (!lines[i].trim()) continue;
    const cells = (Papa.parse<string[]>(lines[i]).data[0] ?? []).map(String);
    if (looksLikeHeader(cells)) return i === 0 ? text : lines.slice(i).join('\n');
  }
  return text;
}

/** Reads just the header line and a few sample rows, for the column-mapping UI. */
export function inspectHeaders(csvText: string, sampleSize = 5) {
  const parsed = Papa.parse<Record<string, string>>(fromHeaderLine(csvText), {
    header: true,
    skipEmptyLines: 'greedy',
    preview: sampleSize,
  });
  const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
  return { headers, sampleRows: parsed.data };
}

/** Returns the first preset whose required columns are all present. */
export function detectPreset(headers: string[]): HeaderPreset | null {
  const present = new Set(headers.map(headerKey));
  return (
    HEADER_PRESETS.find((preset) => preset.required.every((column) => present.has(column))) ?? null
  );
}

/**
 * A mapping for these headers, when one can be worked out without asking.
 *
 * The US card presets go first — their headers are exact and so are their
 * conventions. Anything else is read by what its columns are called, which is
 * what lets an HDFC, SBI, ICICI or Axis export through without a preset per
 * bank. Returns null when the date, the description or the money cannot all be
 * found; the caller then asks the user.
 */
export function detectMapping(
  headers: string[],
): { id: PresetId; label: string; mapping: ColumnMapping } | null {
  const preset = detectPreset(headers);
  if (preset && preset.id !== 'generic') return preset;

  const txnDate = findColumn(headers, 'txnDate');
  const plainDate = findColumn(headers, 'date');
  const postingDate = findColumn(headers, 'postingDate');
  const valueDate = findColumn(headers, 'valueDate');
  const date = txnDate ?? plainDate ?? postingDate ?? valueDate;
  const description = findColumn(headers, 'description');
  if (!date || !description) return null;

  // The date money actually moved, when the export carries it separately.
  const posted = [valueDate, postingDate].find((column) => column && column !== date);

  const debit = findColumn(headers, 'debit');
  const credit = findColumn(headers, 'credit');
  if (debit && credit) {
    return {
      id: 'debit-credit',
      label: 'Separate debit and credit columns',
      mapping: {
        date,
        description,
        debit,
        credit,
        ...(posted ? { postedDate: posted } : {}),
        amountSign: 'debit-positive',
      },
    };
  }

  const amount = findColumn(headers, 'amount');
  if (!amount) return null;
  const drCr = findColumn(headers, 'drCr');
  return {
    id: 'generic',
    label: HEADER_PRESETS.find((p) => p.id === 'generic')!.label,
    mapping: {
      date,
      description,
      amount,
      ...(drCr ? { drCr } : {}),
      ...(posted ? { postedDate: posted } : {}),
      amountSign: 'debit-positive',
    },
  };
}

/**
 * Resolves a mapping's column names against the file's actual headers, so
 * `Transaction Date` still matches a header of `transaction date`.
 */
function resolveColumns(headers: string[], mapping: ColumnMapping) {
  const byKey = new Map(headers.map((h) => [headerKey(h), h]));
  const find = (name: string | undefined) => (name ? byKey.get(headerKey(name)) : undefined);
  return {
    date: find(mapping.date),
    postedDate: find(mapping.postedDate),
    description: find(mapping.description),
    amount: find(mapping.amount),
    debit: find(mapping.debit),
    credit: find(mapping.credit),
    drCr: find(mapping.drCr),
  };
}

/**
 * Parses a date into ISO: `YYYY-MM-DD`, `DD/MM/YYYY` (or `MM/DD/YYYY` when
 * told), `DD-MM-YY`, `DD.MM.YYYY`, `15-Mar-2026`. Returns null when the value
 * is not a date this understands, so the row is reported rather than silently
 * coerced.
 */
export function parseDate(value: string, order: DateOrder = 'dmy'): string | null {
  return parseStatementDate(value, order);
}

/** A trailing Cr/Dr marker: `1,200.00 Cr`, `1200.00CR`, `9,371.92 (Dr)`. */
const MARKER = /\s*\(?\s*(cr|dr)\.?\s*\)?\s*$/i;

/** Which way a figure says the money went, when it carries a Cr/Dr marker. */
export function amountMarker(value: string): 'cr' | 'dr' | null {
  const match = MARKER.exec(value?.trim() ?? '');
  return match ? (match[1].toLowerCase() as 'cr' | 'dr') : null;
}

/**
 * Parses money as written by banks: `$1,234.56`, `₹1,23,456.78`, `Rs. 500`,
 * `INR 500`, `(12.34)` for negatives, a trailing `Cr`/`Dr`, a bare `-` for
 * zero, and stray whitespace. The Cr/Dr marker is stripped here and read with
 * `amountMarker`; this returns the figure as written.
 */
export function parseAmount(value: string): number | null {
  const trimmed = value?.trim().replace(MARKER, '');
  if (!trimmed || trimmed === '-') return null;

  const negatedByParens = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/\b(rs\.?|inr)(?=[\s\d.-]|$)/gi, '').replace(/[()$₹\s,]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negatedByParens ? -parsed : parsed;
}

/** What a Dr/Cr column's value says, or null when it says neither. */
function drCrValue(value: string | undefined): 'cr' | 'dr' | null {
  const v = value?.trim().toLowerCase().replace(/\.$/, '');
  if (!v) return null;
  if (/^(cr|c|credit|deposit)$/.test(v)) return 'cr';
  if (/^(dr|d|debit|withdrawal)$/.test(v)) return 'dr';
  return null;
}

/** Parses a CSV body into normalized, debit-positive rows. */
export function parseTransactions(csvText: string, mapping: ColumnMapping): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(fromHeaderLine(csvText), {
    header: true,
    skipEmptyLines: 'greedy',
  });

  const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
  const columns = resolveColumns(headers, mapping);

  const splitColumns = !mapping.amount && Boolean(mapping.debit || mapping.credit);
  const missing = [
    ...(['date', 'description'] as const).filter((field) => !columns[field]),
    ...(splitColumns
      ? (['debit', 'credit'] as const).filter((field) => mapping[field] && !columns[field])
      : columns.amount
        ? []
        : ['amount']),
  ];
  if (missing.length > 0) {
    throw new CsvMappingError(`CSV is missing required column(s): ${missing.join(', ')}`, headers);
  }

  const cell = (record: Record<string, string>, column: string | undefined) =>
    column ? (record[column] ?? '') : '';

  const dateOrder = mapping.dateOrder
    ? { order: mapping.dateOrder, basis: 'mapping' as const }
    : detectDateOrderFrom(
        parsed.data.flatMap((record) => [
          cell(record, columns.date),
          cell(record, columns.postedDate),
        ]),
      );

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];

  parsed.data.forEach((record, i) => {
    const index = i + 1;
    const rawDate = cell(record, columns.date);
    const rawDescription = cell(record, columns.description).trim();
    const moneyCells = splitColumns
      ? [cell(record, columns.debit), cell(record, columns.credit)]
      : [cell(record, columns.amount)];

    // A line with no date and no figure is not a transaction: the row of
    // asterisks under an HDFC header, a "Statement Summary" caption. Anything
    // that has either is a row, and a bad one is reported rather than dropped.
    if (!/\d/.test(rawDate) && !moneyCells.some((v) => /\d/.test(v))) return;

    const date = parseDate(rawDate, dateOrder.order);
    if (!date) {
      errors.push({ index, reason: `Unrecognised date: "${rawDate}"`, values: record });
      return;
    }

    let amount: number;
    if (splitColumns) {
      const [rawDebit, rawCredit] = moneyCells;
      const debit = parseAmount(rawDebit);
      const credit = parseAmount(rawCredit);
      // Some exports write 0.00 in the column that does not apply.
      const hasDebit = debit !== null && debit !== 0;
      const hasCredit = credit !== null && credit !== 0;
      if (hasDebit && hasCredit) {
        errors.push({ index, reason: 'Row has both a debit and a credit', values: record });
        return;
      }
      if (!hasDebit && !hasCredit) {
        const unreadable = [rawDebit, rawCredit].find((v) => v.trim() && parseAmount(v) === null);
        errors.push({
          index,
          reason: unreadable
            ? `Unrecognised amount: "${unreadable}"`
            : 'Row has neither a debit nor a credit',
          values: record,
        });
        return;
      }
      amount = hasDebit ? Math.abs(debit!) : -Math.abs(credit!);
    } else {
      const rawAmount = moneyCells[0];
      const figure = parseAmount(rawAmount);
      if (figure === null) {
        errors.push({ index, reason: `Unrecognised amount: "${rawAmount}"`, values: record });
        return;
      }
      // An explicit direction — a Cr/Dr on the figure or in its own column —
      // settles the sign; otherwise the export's convention does.
      const direction = amountMarker(rawAmount) ?? drCrValue(cell(record, columns.drCr));
      if (direction === 'cr') amount = -Math.abs(figure);
      else if (direction === 'dr') amount = Math.abs(figure);
      else amount = mapping.amountSign === 'credit-positive' ? -figure : figure;
    }

    if (!rawDescription) {
      errors.push({ index, reason: 'Missing description', values: record });
      return;
    }

    const { rawMerchant, normalizedMerchant } = extractMerchant(rawDescription);
    const postedDate = columns.postedDate
      ? parseDate(cell(record, columns.postedDate), dateOrder.order)
      : null;

    rows.push({
      index,
      date,
      postedDate,
      description: rawDescription,
      rawMerchant,
      normalizedMerchant,
      amount,
    });
  });

  return { rows, errors, dateOrder };
}

/** Raised when the supplied mapping does not fit the file's headers. */
export class CsvMappingError extends Error {
  constructor(
    message: string,
    readonly headers: string[],
  ) {
    super(message);
    this.name = 'CsvMappingError';
  }
}
