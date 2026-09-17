import { api } from '@/lib/api';

/** Mirrors `RANGE_KINDS` on the server. */
export type RangeKind = 'daily' | 'monthly' | 'custom';

export interface RangeTotals {
  range: { kind: RangeKind; startDate: string; endDate: string; month: string | null };
  filters: { accountId: string | null };
  /** Money out, as a positive magnitude. */
  totalDebits: number;
  /** Money in, as a positive magnitude. */
  totalCredits: number;
  /** `totalDebits - totalCredits`. Positive: more left than arrived. */
  net: number;
  transactionCount: number;
}

export interface TotalsParams {
  range: RangeKind;
  /** YYYY-MM-DD, for `daily`. */
  date?: string;
  /** YYYY-MM, for `monthly`. */
  month?: string;
  /** YYYY-MM-DD, for `custom`. */
  startDate?: string;
  /** YYYY-MM-DD, inclusive, for `custom`. */
  endDate?: string;
  accountId?: string;
}

export async function fetchTotals(params: TotalsParams): Promise<RangeTotals> {
  const { data } = await api.get<RangeTotals>('/api/totals', { params });
  return data;
}

// --------------------------------------------------------------------------
// Calendar helpers for the quick-select chips
// --------------------------------------------------------------------------

/**
 * A local calendar date as YYYY-MM-DD.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which converts to UTC first
 * and so hands back yesterday for anyone east of Greenwich in the evening —
 * and India is UTC+5:30, where that is most of the evening.
 */
export function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The local calendar month as YYYY-MM, for the same reason. */
export function isoMonth(date: Date): string {
  return isoDate(date).slice(0, 7);
}

/** The calendar quarter containing `date`, as an inclusive pair of ISO dates. */
export function quarterRange(date: Date): { startDate: string; endDate: string } {
  const firstMonth = Math.floor(date.getMonth() / 3) * 3;
  const start = new Date(date.getFullYear(), firstMonth, 1);
  // Day 0 of the month after the quarter is the quarter's last day, which
  // saves knowing whether it ends on the 30th, the 31st or a leap-year 29th.
  const end = new Date(date.getFullYear(), firstMonth + 3, 0);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}
