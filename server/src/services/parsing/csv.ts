/**
 * Server-side CSV parsing.
 *
 * Everything about interpreting a bank export lives here: which columns mean
 * what, how each institution signs its amounts, and how dates and money are
 * spelled. The client never parses anything — it uploads bytes and renders
 * whatever this returns (PROJECT_CONTEXT.md §4).
 */
import Papa from 'papaparse';

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
  amount: string;
  postedDate?: string;
  amountSign: AmountSign;
}

export type PresetId = 'generic' | 'chase' | 'amex';

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
}

/** Case- and whitespace-insensitive header comparison. */
function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Reads just the header line and a few sample rows, for the column-mapping UI. */
export function inspectHeaders(csvText: string, sampleSize = 5) {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
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
  };
}

/**
 * Parses `YYYY-MM-DD`, `MM/DD/YYYY` and `DD/MM/YYYY`-free `M/D/YY` forms into an
 * ISO date. Returns null when the value is not a date this understands, so the
 * row is reported rather than silently coerced.
 */
export function parseDate(value: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  if (slash) {
    const year = Number(slash[3]);
    return toIso(year < 100 ? 2000 + year : year, Number(slash[1]), Number(slash[2]));
  }

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Parses money as written by banks: `$1,234.56`, `(12.34)` for negatives, a
 * bare `-` for zero, and stray whitespace.
 */
export function parseAmount(value: string): number | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '-') return null;

  const negatedByParens = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$\s,]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negatedByParens ? -parsed : parsed;
}

/** Parses a CSV body into normalized, debit-positive rows. */
export function parseTransactions(csvText: string, mapping: ColumnMapping): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
  });

  const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
  const columns = resolveColumns(headers, mapping);

  const missing = (['date', 'description', 'amount'] as const).filter((field) => !columns[field]);
  if (missing.length > 0) {
    throw new CsvMappingError(`CSV is missing required column(s): ${missing.join(', ')}`, headers);
  }

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];

  parsed.data.forEach((record, i) => {
    const index = i + 1;
    const rawDate = record[columns.date!] ?? '';
    const rawDescription = (record[columns.description!] ?? '').trim();
    const rawAmount = record[columns.amount!] ?? '';

    const date = parseDate(rawDate);
    const amount = parseAmount(rawAmount);

    if (!date) {
      errors.push({ index, reason: `Unrecognised date: "${rawDate}"`, values: record });
      return;
    }
    if (amount === null) {
      errors.push({ index, reason: `Unrecognised amount: "${rawAmount}"`, values: record });
      return;
    }
    if (!rawDescription) {
      errors.push({ index, reason: 'Missing description', values: record });
      return;
    }

    const { rawMerchant, normalizedMerchant } = extractMerchant(rawDescription);
    const postedDate = columns.postedDate ? parseDate(record[columns.postedDate] ?? '') : null;

    rows.push({
      index,
      date,
      postedDate,
      description: rawDescription,
      rawMerchant,
      normalizedMerchant,
      // Normalize every source onto FinTrack's debit-positive convention.
      amount: mapping.amountSign === 'credit-positive' ? -amount : amount,
    });
  });

  return { rows, errors };
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
