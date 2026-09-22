/**
 * Monthly category budgets (Phase 20).
 *
 * A budget is a limit per category per calendar month. The limit is stored;
 * the spend against it never is — it is read from the same aggregation the
 * dashboard uses, so the two screens cannot tell a person different things.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import type { Category } from '../generated/prisma/client';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import {
  UNBUDGETABLE,
  budgetProgress,
  monthElapsed,
  type BudgetProgress,
} from '../services/budgets/progress';
import { aggregateDashboard } from '../services/dashboard/aggregate';
import { comparisonWindow, monthWindow, toIsoMonth } from '../services/dashboard/window';
import { CATEGORIES } from '../services/rules/categories';

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
  .optional();

const budgetableCategory = z
  .enum(CATEGORIES)
  .refine((category) => !UNBUDGETABLE.includes(category), {
    message: `A budget cannot be set for ${UNBUDGETABLE.join(', ')}`,
  });

const amountSchema = z.object({
  amount: z
    .number()
    .finite()
    .positive('A budget must be more than zero')
    .max(9_999_999_999.99, 'That budget is larger than the ledger can hold'),
});

/**
 * GET /api/budgets?month=YYYY-MM
 *
 * Every budget with the month's spend against it, plus what was spent in
 * categories with no budget at all — the part of the month a set of budgets
 * says nothing about.
 */
export const getBudgets: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const month = monthSchema.parse(req.query.month) ?? toIsoMonth(new Date());

  const window = monthWindow(month);
  const previous = comparisonWindow(window, month);

  const [budgets, dashboard] = await Promise.all([
    getPrisma().budget.findMany({
      where: { userId },
      select: { category: true, amount: true },
      orderBy: { category: 'asc' },
    }),
    aggregateDashboard(getPrisma(), {
      userId,
      from: window.from,
      to: window.to,
      previousFrom: previous.from,
      previousTo: previous.to,
      granularity: 'daily',
    }),
  ]);

  const spendBy = new Map<Category, number>(
    dashboard.byCategory.map((c) => [c.category, c.amount] as const),
  );

  const progress: BudgetProgress[] = budgets
    .map((b) => budgetProgress(b.category, Number(b.amount), spendBy.get(b.category) ?? 0))
    // Most at risk first: that is what somebody opening this page wants.
    .sort((a, b) => b.percent - a.percent || a.category.localeCompare(b.category));

  const budgeted = new Set(budgets.map((b) => b.category));
  const unbudgetedSpend = dashboard.byCategory
    .filter((c) => !budgeted.has(c.category) && !UNBUDGETABLE.includes(c.category) && c.amount > 0)
    .reduce((sum, c) => sum + c.amount, 0);

  const totalBudgeted = progress.reduce((sum, p) => sum + p.amount, 0);
  const totalSpent = progress.reduce((sum, p) => sum + p.spent, 0);

  res.json({
    month,
    monthElapsed: monthElapsed(month),
    budgets: progress,
    totals: {
      budgeted: Math.round(totalBudgeted * 100) / 100,
      spent: Math.round(totalSpent * 100) / 100,
      remaining: Math.round((totalBudgeted - totalSpent) * 100) / 100,
      unbudgetedSpend: Math.round(unbudgetedSpend * 100) / 100,
      over: progress.filter((p) => p.status === 'over').length,
      warning: progress.filter((p) => p.status === 'warning').length,
    },
  });
};

function categoryParam(req: { params: Record<string, string | string[] | undefined> }) {
  const result = budgetableCategory.safeParse(req.params.category);
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? 'Unknown category');
  }
  return result.data;
}

/** PUT /api/budgets/:category — set or replace a budget. */
export const putBudget: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const category = categoryParam(req);
  const { amount } = amountSchema.parse(req.body);

  const budget = await getPrisma().budget.upsert({
    where: { userId_category: { userId, category } },
    create: { userId, category, amount: amount.toFixed(2) },
    update: { amount: amount.toFixed(2) },
    select: { category: true, amount: true },
  });

  res.json({ budget: { category: budget.category, amount: Number(budget.amount) } });
};

/** DELETE /api/budgets/:category */
export const deleteBudget: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const category = categoryParam(req);

  const { count } = await getPrisma().budget.deleteMany({ where: { userId, category } });
  if (count === 0) throw new HttpError(404, `No budget set for ${category}`);
  res.status(204).send();
};
