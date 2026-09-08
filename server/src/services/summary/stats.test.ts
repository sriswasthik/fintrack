import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../../generated/prisma/client';
import type { CategoryTotal } from '../dashboard/aggregate';

const deps = vi.hoisted(() => ({
  aggregateDashboard: vi.fn(),
  refreshAnomalies: vi.fn(),
  listInsights: vi.fn(),
}));

vi.mock('../dashboard/aggregate', () => ({ aggregateDashboard: deps.aggregateDashboard }));
vi.mock('../anomalies/apply', () => ({
  refreshAnomalies: deps.refreshAnomalies,
  listInsights: deps.listInsights,
}));

import {
  buildMonthlyStats,
  monthLabel,
  previousMonthOf,
  savingsRate,
  topCategories,
  TOP_CATEGORY_COUNT,
} from './stats';

const category = (name: CategoryTotal['category'], amount: number, share = 0): CategoryTotal => ({
  category: name,
  amount,
  transactions: 1,
  share,
});

describe('monthLabel', () => {
  it('reads the way a person would say it', () => {
    expect(monthLabel('2026-06')).toBe('June 2026');
    expect(monthLabel('2026-01')).toBe('January 2026');
  });
});

describe('previousMonthOf', () => {
  it('steps back one calendar month', () => {
    expect(previousMonthOf('2026-06')).toBe('2026-05');
  });

  it('crosses a year boundary', () => {
    expect(previousMonthOf('2026-01')).toBe('2025-12');
  });
});

describe('savingsRate', () => {
  it('is what is left of income after spending', () => {
    expect(savingsRate(10000, 8000)).toBe(20);
    expect(savingsRate(10926.72, 8959.49)).toBe(18);
  });

  it('goes negative when the month cost more than it earned', () => {
    expect(savingsRate(1000, 1500)).toBe(-50);
  });

  it('is null rather than infinite when there was no income', () => {
    expect(savingsRate(0, 500)).toBeNull();
    expect(savingsRate(-100, 500)).toBeNull();
  });
});

describe('topCategories', () => {
  const current = [
    category('HOUSING', 2150, 24),
    category('SHOPPING', 1945.84, 21.7),
    category('TRAVEL', 1052.14, 11.7),
    category('DINING', 900, 10),
  ];

  it('takes the largest few and works out how each moved', () => {
    const previous = [category('SHOPPING', 4917.4), category('HOUSING', 2150)];
    const top = topCategories(current, previous);

    expect(top).toHaveLength(TOP_CATEGORY_COUNT);
    expect(top[0]).toMatchObject({ category: 'HOUSING', amount: 2150, change: 0 });
    expect(top[1]).toMatchObject({ category: 'SHOPPING', previousAmount: 4917.4, change: -60.4 });
  });

  it('reports no change rather than an infinite one for a category that is new', () => {
    const top = topCategories([category('TRAVEL', 1052.14)], []);
    expect(top[0]).toMatchObject({ previousAmount: 0, change: null });
  });

  it('leaves INCOME out — a salary is not a spending category', () => {
    const withIncome = [category('INCOME', -10926.72), ...current];
    expect(topCategories(withIncome, []).map((c) => c.category)).not.toContain('INCOME');
  });

  it('leaves out a category that nets to nothing after refunds', () => {
    const refunded = [category('SHOPPING', 0), category('DINING', 900)];
    expect(topCategories(refunded, []).map((c) => c.category)).toEqual(['DINING']);
  });
});

describe('buildMonthlyStats', () => {
  const prisma = {} as PrismaClient;

  const dashboard = (over: Record<string, unknown> = {}) => ({
    totals: { spend: 8959.49, income: 10926.72, net: 1967.23, transactions: 111 },
    previous: { spend: 13295.66, income: 8225.77, net: -5069.89, transactions: 124 },
    deltas: { spend: -32.6, income: 32.8 },
    byCategory: [category('HOUSING', 2150, 24), category('SHOPPING', 1945.84, 21.7)],
    series: [],
    topMerchants: [{ merchant: 'OAKWOOD PROPERTY MGMT', amount: 2150, transactions: 1 }],
    availableMonths: [],
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    deps.aggregateDashboard.mockResolvedValue(dashboard());
    deps.refreshAnomalies.mockResolvedValue({ month: '2026-06', detected: 0 });
    deps.listInsights.mockResolvedValue([]);
  });

  it('reports the same totals the dashboard does, because it asks the same query', async () => {
    const stats = await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });

    expect(stats).toMatchObject({
      month: '2026-06',
      monthLabel: 'June 2026',
      previousMonthLabel: 'May 2026',
      spend: 8959.49,
      income: 10926.72,
      net: 1967.23,
      transactions: 111,
      spendChange: -32.6,
      incomeChange: 32.8,
      savingsRate: 18,
    });
  });

  it('aggregates twice — this month and last — and not once per category', async () => {
    await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });
    expect(deps.aggregateDashboard).toHaveBeenCalledTimes(2);
  });

  it('asks for the right two windows', async () => {
    await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });

    const [current, previous] = deps.aggregateDashboard.mock.calls.map((call) => call[1]);
    expect(current.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(current.to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(previous.from.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(previous.to.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('refreshes the anomaly flags before reading them, so the recap is not stale', async () => {
    await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });

    expect(deps.refreshAnomalies).toHaveBeenCalledWith(prisma, { userId: 'u1', month: '2026-06' });
    expect(deps.refreshAnomalies.mock.invocationCallOrder[0]).toBeLessThan(
      deps.listInsights.mock.invocationCallOrder[0],
    );
  });

  it('carries the active flags through as explanations, not as raw rows', async () => {
    deps.listInsights.mockResolvedValue([
      {
        id: 'flag_1',
        type: 'SUBSCRIPTION_PRICE_INCREASE',
        severity: 'MEDIUM',
        explanation: 'NETFLIX went up from $15.49 to $17.99.',
        transactionId: 'txn_1',
        transaction: { id: 'txn_1', description: 'NETFLIX.COM' },
      },
    ]);

    const stats = await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });

    expect(stats.anomalies).toEqual([
      {
        type: 'SUBSCRIPTION_PRICE_INCREASE',
        severity: 'MEDIUM',
        explanation: 'NETFLIX went up from $15.49 to $17.99.',
      },
    ]);
    // The transaction behind the flag is not part of what the model is told.
    expect(JSON.stringify(stats)).not.toContain('txn_1');
  });

  it('carries no transaction rows of any kind', async () => {
    const stats = await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });
    const serialized = JSON.stringify(stats);

    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toContain('description');
    expect(serialized).not.toContain('rawMerchant');
  });

  it('copes with a month that had no spending at all', async () => {
    deps.aggregateDashboard.mockResolvedValue(
      dashboard({
        totals: { spend: 0, income: 0, net: 0, transactions: 0 },
        deltas: { spend: null, income: null },
        byCategory: [],
        topMerchants: [],
      }),
    );

    const stats = await buildMonthlyStats(prisma, { userId: 'u1', month: '2026-06' });

    expect(stats.topCategories).toEqual([]);
    expect(stats.topMerchant).toBeNull();
    expect(stats.savingsRate).toBeNull();
  });
});
