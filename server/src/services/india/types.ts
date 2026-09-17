/**
 * Shared input shape for the Phase 19 detectors.
 *
 * Every detector in this folder is a **pure function of the rows handed in** —
 * no clock, no database, no model call. That is the whole design constraint of
 * the phase: a person is being told "this is your salary" or "this EMI has
 * about eleven payments left", and a claim like that has to be reproducible and
 * explainable from the data, not generated.
 *
 * The thresholds all live in exported `DEFAULTS` objects so they can be tuned
 * from one place, and `docs/INDIA_FEATURES.md` documents what each one means
 * and why it is set where it is.
 */
import type { Category } from '../../generated/prisma/enums';

/** The fields these detectors read. Deliberately a subset of `Transaction`. */
export interface IndiaTransaction {
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Debit-positive: money out is positive, money in is negative. */
  amount: number;
  category: Category;
  /** The cleaned merchant key — the payer or payee reference. */
  normalizedMerchant: string;
  /** The raw narration, which is where EMI keywords usually live. */
  description?: string;
}

/** YYYY-MM of an ISO date. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** Day of month, 1-31, as a number. */
export const dayOf = (date: string): number => Number(date.slice(8, 10));

/** Rounds to paise. Sums of floats are not associative; explanations must be stable. */
export const round2 = (amount: number): number => Math.round(amount * 100) / 100;

/** Whole days from `a` to `b`. Negative when `b` is earlier. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** `count` months ending at `month`, oldest first. */
export function trailingMonths(month: string, count: number): string[] {
  const [year, index] = month.split('-').map(Number);
  const months: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    months.push(new Date(Date.UTC(year, index - 1 - back, 1)).toISOString().slice(0, 7));
  }
  return months;
}

/** The month `count` months after `month`. */
export function addMonths(month: string, count: number): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1 + count, 1)).toISOString().slice(0, 7);
}

/**
 * An ISO date for `day` of `month`, clamped to the last day the month has.
 *
 * A bill due on the 31st falls on the 30th in April and the 28th in February.
 * Rolling into the next month instead — which is what `Date.UTC(y, m, 31)` does
 * on its own — would predict a due date in the wrong month entirely.
 */
export function dateInMonth(month: string, day: number): string {
  const [year, index] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const clamped = Math.min(Math.max(day, 1), lastDay);
  return `${month}-${String(clamped).padStart(2, '0')}`;
}

/** How far apart two days-of-month are, the short way round a 30-day dial. */
export function dayOfMonthDistance(a: number, b: number): number {
  const direct = Math.abs(a - b);
  // The 1st and the 30th are one day apart on a calendar, not twenty-nine: a
  // bill that slips from the 1st to the 30th of the month before has not moved
  // to a different part of the month.
  return Math.min(direct, 31 - direct);
}
