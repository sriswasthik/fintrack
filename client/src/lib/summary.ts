import { api } from '@/lib/api';
import type { AnomalySeverity, AnomalyType } from '@/lib/insights';
import type { Category } from '@/lib/transactions';

export interface CategoryStat {
  category: Category;
  amount: number;
  previousAmount: number;
  /** Percentage change vs the previous month, or null when it had nothing. */
  change: number | null;
  share: number;
}

export interface AnomalyStat {
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
}

export interface MonthlyStats {
  month: string;
  monthLabel: string;
  previousMonth: string;
  previousMonthLabel: string;
  spend: number;
  income: number;
  net: number;
  transactions: number;
  previousSpend: number;
  previousIncome: number;
  spendChange: number | null;
  incomeChange: number | null;
  savingsRate: number | null;
  topCategories: CategoryStat[];
  topMerchant: { merchant: string; amount: number; transactions: number } | null;
  anomalies: AnomalyStat[];
}

export interface MonthlySummary {
  month: string;
  content: string;
  stats: MonthlyStats;
  /** 'fallback' means the figures are shown as written, not as prose. */
  source: 'model' | 'fallback';
  cached: boolean;
  /** The figures have moved since the text was written. */
  stale: boolean;
  generatedAt: string;
  /** Set when the model could not be reached at all. */
  unavailable?: string;
}

export interface SummaryParams {
  month?: string;
  accountId?: string;
}

const query = (params: SummaryParams) => ({
  ...(params.month ? { month: params.month } : {}),
  ...(params.accountId ? { accountId: params.accountId } : {}),
});

export async function fetchSummary(params: SummaryParams): Promise<MonthlySummary> {
  const { data } = await api.get<MonthlySummary>('/api/summary', { params: query(params) });
  return data;
}

export async function regenerateSummary(params: SummaryParams): Promise<MonthlySummary> {
  const { data } = await api.post<MonthlySummary>('/api/summary/regenerate', null, {
    params: query(params),
  });
  return data;
}
