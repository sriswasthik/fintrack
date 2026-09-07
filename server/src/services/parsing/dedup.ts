/**
 * Duplicate detection for an incoming import.
 *
 * Two rows are considered the same transaction when they land on the same
 * account, carry the same amount and the same normalized merchant, and their
 * dates are within a day of each other. The one-day window absorbs the common
 * case of a re-export shifting a transaction between its authorisation and
 * posting date.
 *
 * This is deliberately a *flagger*, not a filter. PROJECT_CONTEXT.md §8 case 5
 * is explicit that a sync glitch and a legitimately repeated small charge (two
 * coffees on the same day at the same price) are indistinguishable by value —
 * so the pipeline surfaces both and the user decides, rather than guessing and
 * silently dropping a real charge.
 *
 * Everything here is pure: the caller loads candidate rows from the database
 * and passes them in, which keeps this testable without one.
 */
import type { ParsedRow } from './csv';

/** The shape of an already-stored transaction that matching needs. */
export interface ExistingTransaction {
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  amount: number;
  normalizedMerchant: string;
}

export type DuplicateKind = 'existing' | 'in-file';

export interface DuplicateMatch {
  kind: DuplicateKind;
  /** Set when `kind` is 'existing'. */
  existingTransactionId?: string;
  /** Set when `kind` is 'in-file': the 1-based index of the earlier row. */
  matchesRowIndex?: number;
  existingDate: string;
  reason: string;
}

export interface FlaggedRow extends ParsedRow {
  duplicate: DuplicateMatch | null;
}

/** Inclusive day window either side of the incoming date. */
export const DEDUP_DAY_WINDOW = 1;

function daysApart(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.abs(Math.round(ms / 86400000));
}

/** Amounts are compared in whole cents to avoid float drift. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

function isMatch(
  row: { date: string; amount: number; normalizedMerchant: string },
  candidate: { date: string; amount: number; normalizedMerchant: string },
): boolean {
  return (
    cents(row.amount) === cents(candidate.amount) &&
    row.normalizedMerchant === candidate.normalizedMerchant &&
    daysApart(row.date, candidate.date) <= DEDUP_DAY_WINDOW
  );
}

/**
 * Flags each incoming row that looks like a duplicate.
 *
 * Matches against `existing` (transactions already on the account) take
 * precedence over matches earlier in the same file, because re-importing an
 * overlapping export is the more common and more consequential case.
 *
 * @param rows      Parsed rows, in file order.
 * @param existing  Transactions already stored on the target account.
 */
export function flagDuplicates(rows: ParsedRow[], existing: ExistingTransaction[]): FlaggedRow[] {
  // Bucket the stored rows by merchant so each incoming row compares against a
  // handful of candidates rather than the whole account.
  const byMerchant = new Map<string, ExistingTransaction[]>();
  existing.forEach((t) => {
    const bucket = byMerchant.get(t.normalizedMerchant);
    if (bucket) bucket.push(t);
    else byMerchant.set(t.normalizedMerchant, [t]);
  });

  const seenInFile: ParsedRow[] = [];

  return rows.map((row) => {
    const candidates = byMerchant.get(row.normalizedMerchant) ?? [];
    const existingMatch = candidates.find((candidate) => isMatch(row, candidate));

    if (existingMatch) {
      seenInFile.push(row);
      return {
        ...row,
        duplicate: {
          kind: 'existing',
          existingTransactionId: existingMatch.id,
          existingDate: existingMatch.date,
          reason: `Already imported on ${existingMatch.date} for the same amount and merchant`,
        },
      };
    }

    const earlier = seenInFile.find((previous) => isMatch(row, previous));
    seenInFile.push(row);

    if (earlier) {
      return {
        ...row,
        duplicate: {
          kind: 'in-file',
          matchesRowIndex: earlier.index,
          existingDate: earlier.date,
          reason: `Same amount and merchant as row ${earlier.index} in this file`,
        },
      };
    }

    return { ...row, duplicate: null };
  });
}

/** Convenience: the widest date range the incoming rows span, for the DB query. */
export function dateRangeOf(rows: ParsedRow[]): { from: string; to: string } | null {
  if (rows.length === 0) return null;
  const dates = rows.map((r) => r.date).sort();
  const shift = (iso: string, days: number) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return {
    from: shift(dates[0], -DEDUP_DAY_WINDOW),
    to: shift(dates[dates.length - 1], DEDUP_DAY_WINDOW),
  };
}
