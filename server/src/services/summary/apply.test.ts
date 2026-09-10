import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../../generated/prisma/client';
import { SummarizerConfigurationError, type MonthlySummarizer } from '../ai/summarize';
import type { MonthlyStats } from './stats';

const deps = vi.hoisted(() => ({ buildMonthlyStats: vi.fn() }));
vi.mock('./stats', () => ({ buildMonthlyStats: deps.buildMonthlyStats }));

import { getMonthlySummary, regenerateMonthlySummary, type SummarySnapshot } from './apply';

const JUNE: MonthlyStats = {
  month: '2026-06',
  monthLabel: 'June 2026',
  previousMonth: '2026-05',
  previousMonthLabel: 'May 2026',
  spend: 8959.49,
  income: 10926.72,
  net: 1967.23,
  transactions: 111,
  previousSpend: 13295.66,
  previousIncome: 8225.77,
  spendChange: -32.6,
  incomeChange: 32.8,
  savingsRate: 18,
  topCategories: [
    { category: 'HOUSING', amount: 2150, previousAmount: 2150, change: 0, share: 24 },
  ],
  topMerchant: { merchant: 'OAKWOOD PROPERTY MGMT', amount: 2150, transactions: 1 },
  anomalies: [],
};

interface Row {
  userId: string;
  month: string;
  content: string;
  statsSnapshot: unknown;
  updatedAt: Date;
}

/** An in-memory MonthlySummary table, so the upsert is really an upsert. */
function fakePrisma(seed: Row[] = []) {
  const rows = [...seed];
  const find = (userId: string, month: string) =>
    rows.find((row) => row.userId === userId && row.month === month);

  const prisma = {
    monthlySummary: {
      findUnique: async ({
        where,
      }: {
        where: { userId_month: { userId: string; month: string } };
      }) => find(where.userId_month.userId, where.userId_month.month) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId_month: { userId: string; month: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = find(where.userId_month.userId, where.userId_month.month);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = { ...(create as unknown as Row), updatedAt: new Date() };
        rows.push(row);
        return row;
      },
    },
  };

  return { prisma: prisma as unknown as PrismaClient, rows };
}

function stubSummarizer(content = 'A summary of June.'): MonthlySummarizer & {
  summarize: ReturnType<typeof vi.fn>;
} {
  const summarize = vi.fn().mockImplementation(async () => ({
    content,
    source: 'model' as const,
    calls: 1,
    rejections: [],
  }));
  return { summarize };
}

function snapshotRow(stats: MonthlyStats, content = 'Cached text.'): Row {
  const snapshot: SummarySnapshot = {
    stats,
    generation: { source: 'model', calls: 1, rejections: [] },
  };
  return {
    userId: 'u1',
    month: '2026-06',
    content,
    statsSnapshot: snapshot,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.buildMonthlyStats.mockResolvedValue(JUNE);
});

describe('getMonthlySummary', () => {
  it('generates and caches when there is nothing stored', async () => {
    const { prisma, rows } = fakePrisma();
    const summarizer = stubSummarizer();

    const record = await getMonthlySummary(prisma, summarizer, { userId: 'u1', month: '2026-06' });

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ content: 'A summary of June.', cached: false, stale: false });
    expect(rows).toHaveLength(1);
  });

  it('serves the cached paragraph without calling the model again', async () => {
    const { prisma } = fakePrisma([snapshotRow(JUNE)]);
    const summarizer = stubSummarizer();

    const record = await getMonthlySummary(prisma, summarizer, { userId: 'u1', month: '2026-06' });

    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(record).toMatchObject({ content: 'Cached text.', cached: true, stale: false });
  });

  it('flags a cached summary as stale once an import moves the numbers', async () => {
    const { prisma } = fakePrisma([snapshotRow(JUNE)]);
    deps.buildMonthlyStats.mockResolvedValue({ ...JUNE, spend: 9500 });

    const record = await getMonthlySummary(prisma, stubSummarizer(), {
      userId: 'u1',
      month: '2026-06',
    });

    expect(record).toMatchObject({ cached: true, stale: true });
    // The text is still shown; it is the client's job to offer a redo.
    expect(record.content).toBe('Cached text.');
  });

  it('is not fooled into staleness by an anomaly explanation being reworded', async () => {
    const { prisma } = fakePrisma([snapshotRow(JUNE)]);
    deps.buildMonthlyStats.mockResolvedValue({
      ...JUNE,
      anomalies: [{ type: 'UNUSUAL_AMOUNT', severity: 'LOW', explanation: 'Reworded.' }],
    });

    const record = await getMonthlySummary(prisma, stubSummarizer(), {
      userId: 'u1',
      month: '2026-06',
    });

    expect(record.stale).toBe(false);
  });

  it('always returns the current stats, even beside a cached paragraph', async () => {
    const { prisma } = fakePrisma([snapshotRow({ ...JUNE, spend: 1 })]);

    const record = await getMonthlySummary(prisma, stubSummarizer(), {
      userId: 'u1',
      month: '2026-06',
    });

    expect(record.stats.spend).toBe(JUNE.spend);
  });

  it('does not read another user-s summary', async () => {
    const { prisma } = fakePrisma([{ ...snapshotRow(JUNE), userId: 'u2' }]);
    const summarizer = stubSummarizer();

    await getMonthlySummary(prisma, summarizer, { userId: 'u1', month: '2026-06' });

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
  });
});

describe('regenerateMonthlySummary', () => {
  it('calls the model even when a summary is already cached', async () => {
    const { prisma, rows } = fakePrisma([snapshotRow(JUNE)]);
    const summarizer = stubSummarizer('A fresh take on June.');

    const record = await regenerateMonthlySummary(prisma, summarizer, {
      userId: 'u1',
      month: '2026-06',
    });

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ content: 'A fresh take on June.', cached: false });
    // Overwritten in place, not duplicated: one summary per user-month.
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('A fresh take on June.');
  });

  it('writes the stats it was generated from, so the text can be checked later', async () => {
    const { prisma, rows } = fakePrisma();
    await regenerateMonthlySummary(prisma, stubSummarizer(), { userId: 'u1', month: '2026-06' });

    const snapshot = rows[0].statsSnapshot as SummarySnapshot;
    expect(snapshot.stats.spend).toBe(JUNE.spend);
    expect(snapshot.generation).toMatchObject({ source: 'model', calls: 1 });
  });
});

describe('a month with nothing in it', () => {
  const empty: MonthlyStats = {
    ...JUNE,
    spend: 0,
    income: 0,
    net: 0,
    transactions: 0,
    savingsRate: null,
    topCategories: [],
    topMerchant: null,
    anomalies: [],
  };

  it('says so without spending a model call', async () => {
    const { prisma, rows } = fakePrisma();
    deps.buildMonthlyStats.mockResolvedValue(empty);
    const summarizer = stubSummarizer();

    const record = await getMonthlySummary(prisma, summarizer, { userId: 'u1', month: '2026-06' });

    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(record.content).toBe('There were no transactions in June 2026.');
    // Free to recompute, so there is nothing worth storing.
    expect(rows).toEqual([]);
  });

  it('will not spend one on regenerate either', async () => {
    const { prisma } = fakePrisma();
    deps.buildMonthlyStats.mockResolvedValue(empty);
    const summarizer = stubSummarizer();

    await regenerateMonthlySummary(prisma, summarizer, { userId: 'u1', month: '2026-06' });

    expect(summarizer.summarize).not.toHaveBeenCalled();
  });
});

describe('when the model is not configured', () => {
  const unconfigured: MonthlySummarizer = {
    summarize: vi.fn().mockRejectedValue(new SummarizerConfigurationError('No API key')),
  };

  it('shows the figures and says why, rather than an error page', async () => {
    const { prisma } = fakePrisma();

    const record = await getMonthlySummary(prisma, unconfigured, {
      userId: 'u1',
      month: '2026-06',
    });

    expect(record.source).toBe('fallback');
    expect(record.unavailable).toContain('not configured');
    expect(record.content).toContain('₹8,959.49');
  });

  it('caches nothing, so fixing the credential is all it takes', async () => {
    const { prisma, rows } = fakePrisma();
    await getMonthlySummary(prisma, unconfigured, { userId: 'u1', month: '2026-06' });
    expect(rows).toEqual([]);
  });

  it('lets a transient failure through instead of caching a shrug', async () => {
    const { prisma, rows } = fakePrisma();
    const flaky: MonthlySummarizer = {
      summarize: vi.fn().mockRejectedValue(new Error('socket hang up')),
    };

    await expect(
      getMonthlySummary(prisma, flaky, { userId: 'u1', month: '2026-06' }),
    ).rejects.toThrow('socket hang up');
    expect(rows).toEqual([]);
  });
});
