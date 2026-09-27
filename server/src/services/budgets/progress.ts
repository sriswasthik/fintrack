/**
 * Budget progress — pure arithmetic, kept apart from the query so the
 * thresholds can be tested without a database (Phase 20).
 *
 * The spend figure it is handed comes from the dashboard aggregation, so a
 * budget can never disagree with the dashboard about what a month cost:
 * transfers are excluded, refunds net against the category they refund, and a
 * split charge counts each part against its own category.
 */
import type { Category } from '../../generated/prisma/client';

/**
 * Categories a budget makes no sense for: money arriving, money moving
 * between your own accounts, and the refund bucket, which nets against the
 * purchase's category rather than standing on its own.
 */
export const UNBUDGETABLE: readonly Category[] = ['INCOME', 'TRANSFER', 'REFUND'];

/**
 * The share of a budget at which it is worth a warning. Far enough from the
 * limit to still change something this month; close enough not to nag.
 */
export const WARNING_RATIO = 0.8;

export type BudgetStatus = 'ok' | 'warning' | 'over';

export interface BudgetProgress {
  category: Category;
  amount: number;
  spent: number;
  /** Negative once over. */
  remaining: number;
  /** Spent as a percentage of the budget, one decimal place. */
  percent: number;
  status: BudgetStatus;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function budgetProgress(category: Category, amount: number, spent: number): BudgetProgress {
  // A month of refunds exceeding purchases nets below zero. That is not
  // "negative spending against a budget"; for the bar it is simply nothing.
  const used = Math.max(0, round2(spent));
  const ratio = amount > 0 ? used / amount : 0;

  return {
    category,
    amount: round2(amount),
    spent: used,
    remaining: round2(amount - used),
    percent: Math.round(ratio * 1000) / 10,
    status: ratio > 1 ? 'over' : ratio >= WARNING_RATIO ? 'warning' : 'ok',
  };
}

/**
 * How far through the month `now` is, 0 to 1 — so the client can mark where
 * spending "should" be by today. A past month is complete; a future one has
 * not started.
 */
export function monthElapsed(month: string, now: Date = new Date()): number {
  const [year, monthIndex] = month.split('-').map(Number);
  const start = Date.UTC(year, monthIndex - 1, 1);
  const end = Date.UTC(year, monthIndex, 1);
  const t = now.getTime();
  if (t <= start) return 0;
  if (t >= end) return 1;
  return Math.round(((t - start) / (end - start)) * 1000) / 1000;
}
