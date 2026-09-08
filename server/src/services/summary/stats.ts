/**
 * The facts a monthly summary is written from.
 *
 * This is the only thing that ever reaches the model (PROJECT_CONTEXT.md §7):
 * a dozen pre-computed numbers, not a single transaction row. That keeps the
 * request small and cheap, but the reason is privacy — a person's merchant
 * history is the most revealing part of their finances, and there is no version
 * of "summarize my month" that requires shipping it anywhere.
 *
 * The figures come from the Phase-5 dashboard aggregation rather than a query
 * of their own. A second query would be a second definition of "spend", and the
 * first month the two disagreed the summary would be worse than useless — a
 * paragraph of confident prose contradicting the chart above it.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import type { AnomalySeverity, AnomalyType, Category } from '../../generated/prisma/enums';
import { listInsights, refreshAnomalies } from '../anomalies/apply';
import { aggregateDashboard, type CategoryTotal } from '../dashboard/aggregate';
import { comparisonWindow, monthWindow, percentageChange, toIsoMonth } from '../dashboard/window';

/** How many categories the summary is given. Three is what a reader retains. */
export const TOP_CATEGORY_COUNT = 3;

export interface CategoryStat {
  category: Category;
  amount: number;
  previousAmount: number;
  /** Percentage change vs the previous month, or null when it had nothing. */
  change: number | null;
  /** Share of the month's spend, as a percentage. */
  share: number;
}

export interface AnomalyStat {
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
}

export interface MonthlyStats {
  /** YYYY-MM. */
  month: string;
  /** How a person would say it: "June 2026". */
  monthLabel: string;
  previousMonth: string;
  previousMonthLabel: string;

  spend: number;
  income: number;
  /** Income minus spend. Negative means the month cost more than it earned. */
  net: number;
  transactions: number;

  previousSpend: number;
  previousIncome: number;
  spendChange: number | null;
  incomeChange: number | null;

  /** Net as a percentage of income, or null when there was no income. */
  savingsRate: number | null;

  topCategories: CategoryStat[];
  topMerchant: { merchant: string; amount: number; transactions: number } | null;
  anomalies: AnomalyStat[];
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The calendar month before `month`. */
export function previousMonthOf(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return toIsoMonth(new Date(Date.UTC(year, index - 2, 1)));
}

/**
 * Picks the categories worth talking about and works out how each moved.
 *
 * Exported for its own tests: which three categories lead a month, and what
 * they did against last month, is the part of the summary a reader will check.
 */
export function topCategories(
  current: CategoryTotal[],
  previous: CategoryTotal[],
  limit = TOP_CATEGORY_COUNT,
): CategoryStat[] {
  const previousByCategory = new Map(previous.map((row) => [row.category, row.amount]));

  return (
    current
      // INCOME is not spending, and a summary that called it the biggest
      // "category" would be describing the user's salary as an expense.
      .filter((row) => row.category !== 'INCOME' && row.amount > 0)
      .slice(0, limit)
      .map((row) => {
        const previousAmount = previousByCategory.get(row.category) ?? 0;
        return {
          category: row.category,
          amount: row.amount,
          previousAmount,
          change: percentageChange(row.amount, previousAmount),
          share: row.share,
        };
      })
  );
}

/** Net as a percentage of income. Null when nothing came in to save out of. */
export function savingsRate(income: number, spend: number): number | null {
  if (income <= 0) return null;
  return Math.round(((income - spend) / income) * 1000) / 10;
}

export interface StatsQuery {
  userId: string;
  /** YYYY-MM. */
  month: string;
}

/**
 * Builds the stats block for one user-month.
 *
 * Two aggregations, not one: the current month and the one before it, because
 * per-category movement needs both sides and the dashboard query only breaks
 * down the window it is centred on. Two is a constant, and constant is the
 * property that matters — nothing here scales with the number of transactions.
 */
export async function buildMonthlyStats(
  prisma: PrismaClient,
  { userId, month }: StatsQuery,
): Promise<MonthlyStats> {
  const previousMonth = previousMonthOf(month);
  const window = monthWindow(month);
  const previousWindow = comparisonWindow(window, month);

  // The anomaly flags are refreshed the same way GET /api/insights refreshes
  // them, so a summary generated before anyone opened the dashboard still
  // describes the same findings the dashboard would show.
  await refreshAnomalies(prisma, { userId, month });

  const [current, previous, insights] = await Promise.all([
    aggregateDashboard(prisma, {
      userId,
      from: window.from,
      to: window.to,
      previousFrom: previousWindow.from,
      previousTo: previousWindow.to,
      granularity: 'daily',
    }),
    aggregateDashboard(prisma, {
      userId,
      from: previousWindow.from,
      to: previousWindow.to,
      previousFrom: comparisonWindow(previousWindow, previousMonth).from,
      previousTo: comparisonWindow(previousWindow, previousMonth).to,
      granularity: 'daily',
    }),
    listInsights(prisma, { userId, month }),
  ]);

  const [topMerchant] = current.topMerchants;

  return {
    month,
    monthLabel: monthLabel(month),
    previousMonth,
    previousMonthLabel: monthLabel(previousMonth),

    spend: round(current.totals.spend),
    income: round(current.totals.income),
    net: round(current.totals.net),
    transactions: current.totals.transactions,

    previousSpend: round(current.previous.spend),
    previousIncome: round(current.previous.income),
    spendChange: current.deltas.spend,
    incomeChange: current.deltas.income,

    savingsRate: savingsRate(current.totals.income, current.totals.spend),

    topCategories: topCategories(current.byCategory, previous.byCategory),
    topMerchant: topMerchant
      ? {
          merchant: topMerchant.merchant,
          amount: round(topMerchant.amount),
          transactions: topMerchant.transactions,
        }
      : null,
    anomalies: insights.map((insight) => ({
      type: insight.type,
      severity: insight.severity,
      explanation: insight.explanation,
    })),
  };
}
