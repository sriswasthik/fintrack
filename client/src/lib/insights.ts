import { api } from '@/lib/api';
import type { Category } from '@/lib/transactions';

export type AnomalyType =
  | 'UNUSUAL_AMOUNT'
  | 'NEW_RECURRING_CHARGE'
  | 'SUBSCRIPTION_PRICE_INCREASE'
  | 'CATEGORY_SPEND_SPIKE'
  | 'POSSIBLE_DUPLICATE';

export type AnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Insight {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  month: string;
  explanation: string;
  transactionId: string | null;
  createdAt: string;
  transaction: {
    id: string;
    date: string;
    description: string;
    merchant: string;
    amount: number;
    category: Category;
  } | null;
}

export interface InsightsResponse {
  month: string;
  insights: Insight[];
  /** Includes flags since dismissed, so the panel can say so rather than look empty. */
  detected: number;
}

export interface InsightsParams {
  month?: string;
  accountId?: string;
}

export async function fetchInsights(params: InsightsParams): Promise<InsightsResponse> {
  const { data } = await api.get<InsightsResponse>('/api/insights', {
    params: {
      ...(params.month ? { month: params.month } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
    },
  });
  return data;
}

export async function dismissInsight(id: string): Promise<void> {
  await api.delete(`/api/insights/${id}`);
}
