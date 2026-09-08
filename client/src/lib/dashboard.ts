import { api } from '@/lib/api';
import type { Category } from '@/lib/transactions';

export type Granularity = 'daily' | 'weekly';

export interface DashboardTotals {
  spend: number;
  income: number;
  net: number;
  transactions: number;
}

export interface CategoryTotal {
  category: Category;
  amount: number;
  transactions: number;
  share: number;
}

export interface SeriesPoint {
  date: string;
  spend: number;
}

export interface MerchantTotal {
  merchant: string;
  amount: number;
  transactions: number;
}

export interface Dashboard {
  range: { from: string; to: string; month: string | null; granularity: Granularity };
  previousRange: { from: string; to: string };
  filters: { accountId: string | null; categories: Category[] | null };
  totals: DashboardTotals;
  previous: DashboardTotals;
  deltas: { spend: number | null; income: number | null };
  byCategory: CategoryTotal[];
  series: SeriesPoint[];
  topMerchants: MerchantTotal[];
  availableMonths: string[];
}

export interface DashboardParams {
  month?: string;
  accountId?: string;
  categories?: Category[];
  granularity?: Granularity;
}

export async function fetchDashboard(params: DashboardParams): Promise<Dashboard> {
  const { data } = await api.get<Dashboard>('/api/dashboard', {
    params: {
      ...(params.month ? { month: params.month } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.categories?.length ? { categories: params.categories.join(',') } : {}),
      granularity: params.granularity ?? 'daily',
    },
  });
  return data;
}
