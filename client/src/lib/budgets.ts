import { api } from '@/lib/api';
import { CATEGORIES, type Category } from '@/lib/transactions';

export type BudgetStatus = 'ok' | 'warning' | 'over';

/**
 * Status is carried by the word as well as the colour, so it reads in a
 * monochrome print and for a red-green colour deficiency alike. Orange rather
 * than red for "over", as in the insights panel: a budget passed is something
 * to look at, not an error.
 */
export const BUDGET_STATUS: Record<BudgetStatus, { label: string; fill: string }> = {
  ok: { label: 'On track', fill: 'bg-[var(--chart-1)]' },
  warning: { label: 'Nearly there', fill: 'bg-[var(--chart-4)]' },
  over: { label: 'Over budget', fill: 'bg-[var(--chart-2)]' },
};

/** "2026-09" for the month `date` falls in, by the local calendar. */
export function isoMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** The month `by` months after (or, negative, before) `month`. */
export function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number);
  return isoMonth(new Date(year, index - 1 + by, 1));
}

export interface BudgetProgress {
  category: Category;
  amount: number;
  spent: number;
  /** Negative once over. */
  remaining: number;
  percent: number;
  status: BudgetStatus;
}

export interface BudgetsResponse {
  month: string;
  /** 0–1: how far through the month today is. 1 for a past month. */
  monthElapsed: number;
  budgets: BudgetProgress[];
  totals: {
    budgeted: number;
    spent: number;
    remaining: number;
    /** Spent in categories with no budget at all. */
    unbudgetedSpend: number;
    over: number;
    warning: number;
  };
}

/** Mirrors `UNBUDGETABLE` on the server: money in, own-account moves, the refund bucket. */
export const UNBUDGETABLE: readonly Category[] = ['INCOME', 'TRANSFER', 'REFUND'];

export const BUDGETABLE_CATEGORIES = CATEGORIES.filter((c) => !UNBUDGETABLE.includes(c));

export async function fetchBudgets(month?: string): Promise<BudgetsResponse> {
  const { data } = await api.get<BudgetsResponse>('/api/budgets', {
    params: month ? { month } : {},
  });
  return data;
}

export async function saveBudget(input: { category: Category; amount: number }): Promise<void> {
  await api.put(`/api/budgets/${input.category}`, { amount: input.amount });
}

export async function removeBudget(category: Category): Promise<void> {
  await api.delete(`/api/budgets/${category}`);
}
