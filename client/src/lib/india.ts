import { api } from '@/lib/api';
import type { Category } from '@/lib/transactions';

/**
 * The Phase 19 India insights — five statistics-only features off one endpoint.
 *
 * Every field here is derived on the server from the transactions themselves;
 * nothing is stored and no model is called, so the same data always produces
 * the same answer. `docs/INDIA_FEATURES.md` documents each heuristic and its
 * thresholds.
 */

export interface SalaryMonth {
  month: string;
  amount: number;
  day: number;
  credits: number;
}

export interface DetectedSalary {
  payer: string;
  /** The typical monthly figure: the median of the months that agreed. */
  monthlyAmount: number;
  payDay: number;
  /** 1 for monthly payroll, 2 for semi-monthly. */
  creditsPerMonth: number;
  months: SalaryMonth[];
  presentInMonth: boolean;
  lastPaidMonth: string;
}

export interface SavingsRate {
  month: string;
  income: number;
  expense: number;
  saved: number;
  /** Null when there was no income — which is not a rate of zero. */
  rate: number | null;
}

export interface TenureEstimate {
  assumedTenureMonths: number;
  remainingMonths: number;
  projectedFinalMonth: string;
  /** Always shown. The statement cannot see when the loan began or how long it runs. */
  caveat: string;
}

export interface DetectedEmi {
  merchant: string;
  monthlyAmount: number;
  debitDay: number;
  firstSeen: string;
  lastSeen: string;
  instalmentsObserved: number;
  active: boolean;
  estimate: TenureEstimate | null;
  nextInstalment: string | null;
}

export interface DetectedSip {
  merchant: string;
  monthlyAmount: number;
  debitDay: number;
  firstSeen: string;
  lastSeen: string;
  contributionsObserved: number;
  active: boolean;
}

export interface UpcomingBill {
  merchant: string;
  category: Category;
  /** Predicted, never observed. */
  expectedDate: string;
  expectedAmount: number;
  lastCharged: string;
  cadenceDays: number;
  expectedDay: number;
  confidence: 'high' | 'medium';
  observations: number;
}

export interface FestiveWindow {
  key: string;
  label: string;
  months: number[];
  description: string;
}

export interface FestiveCategoryMove {
  category: Category;
  amount: number;
  baseline: number;
  ratio: number;
  difference: number;
}

export interface FestiveNote {
  month: string;
  windows: FestiveWindow[];
  categories: FestiveCategoryMove[];
  totalAbove: number;
  baselineMonths: number;
  /** A neutral sentence, safe to render as written. */
  note: string;
}

export interface IndiaInsights {
  month: string;
  salary: DetectedSalary | null;
  savings: SavingsRate;
  loans: { loans: DetectedEmi[]; totalMonthly: number; shareOfIncome: number | null };
  investments: { plans: DetectedSip[]; totalMonthly: number; shareOfIncome: number | null };
  upcoming: { bills: UpcomingBill[]; totalExpected: number };
  festive: FestiveNote | null;
}

export interface IndiaParams {
  month?: string;
  accountId?: string;
}

export async function fetchIndiaInsights(params: IndiaParams): Promise<IndiaInsights> {
  const { data } = await api.get<IndiaInsights>('/api/india', {
    params: {
      ...(params.month ? { month: params.month } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
    },
  });
  return data;
}

/**
 * A ratio as a whole-number percentage, or an em dash when there is none.
 *
 * A negative percentage gets U+2212, the same minus `<Amount>` uses, so the two
 * line up in a column and read alike rather than one wearing a hyphen.
 */
export const asPercent = (ratio: number | null): string => {
  if (ratio === null) return '—';
  const whole = Math.round(ratio * 100);
  return whole < 0 ? `\u2212${Math.abs(whole)}%` : `${whole}%`;
};
