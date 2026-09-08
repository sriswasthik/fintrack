import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../../generated/prisma/client';
import { dismissInsight, listInsights, loadAnomalyTransactions, refreshAnomalies } from './apply';

// ---------------------------------------------------------------------------
// A tiny in-memory stand-in for the two tables this service touches.
//
// Mocking the calls one by one would only prove the calls were made; keeping
// real rows means the properties that matter — an upsert that does not
// duplicate, a dismissal that survives the next detection pass — are actually
// exercised.
// ---------------------------------------------------------------------------

interface FlagRow {
  id: string;
  userId: string;
  month: string;
  fingerprint: string;
  type: string;
  severity: string;
  explanation: string;
  transactionId: string | null;
  dismissedAt: Date | null;
  createdAt: Date;
}

interface TransactionRow {
  id: string;
  date: Date;
  amount: number;
  category: string;
  normalizedMerchant: string;
  description?: string;
  splits?: { category: string; amount: number }[];
  refundFor?: { category: string } | null;
}

function fakePrisma(initial: TransactionRow[] = []) {
  const flags: FlagRow[] = [];
  let transactions = initial;
  let nextId = 1;

  const matches = (row: FlagRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'id' && typeof value === 'object' && value !== null) {
        return (value as { in: string[] }).in.includes(row.id);
      }
      return row[key as keyof FlagRow] === value;
    });

  const client = {
    transaction: {
      findMany: async ({ where }: { where: { date: { lt: Date } } }) =>
        transactions
          .filter((t) => t.date < where.date.lt)
          .map((t) => ({ splits: [], refundFor: null, ...t }))
          .sort((a, b) => a.date.getTime() - b.date.getTime()),
    },
    anomalyFlag: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        flags.filter((row) => matches(row, where)).map((row) => ({ ...row, transaction: null })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `flag_${nextId++}`,
          dismissedAt: null,
          createdAt: new Date(),
          transactionId: null,
          ...data,
        } as FlagRow;
        flags.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = flags.find((f) => f.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = flags.filter((row) => matches(row, where));
        hit.forEach((row) => Object.assign(row, data));
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const doomed = new Set(flags.filter((row) => matches(row, where)).map((row) => row.id));
        for (let i = flags.length - 1; i >= 0; i--) if (doomed.has(flags[i].id)) flags.splice(i, 1);
        return { count: doomed.size };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return {
    prisma: client as unknown as PrismaClient,
    flags,
    /** Rewrites the underlying data, so a second pass can see a changed world. */
    setTransactions: (rows: TransactionRow[]) => {
      transactions = rows;
    },
  };
}

/** A merchant billed on the same day of successive months. */
function monthly(merchant: string, amount: number, from: string, count: number): TransactionRow[] {
  const [year, month, day] = from.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1 + i, day));
    return {
      id: `${merchant}-${i}`,
      date,
      amount,
      category: 'SUBSCRIPTIONS',
      normalizedMerchant: merchant,
      description: merchant,
    };
  });
}

/** Enough unrelated history that "new" is a claim the detector is willing to make. */
const HISTORY: TransactionRow[] = Array.from({ length: 6 }, (_, i) => ({
  id: `history-${i}`,
  date: new Date(Date.UTC(2026, i, 5)),
  amount: 40,
  category: 'GROCERIES',
  normalizedMerchant: `SHOP ${i}`,
  description: `SHOP ${i}`,
}));

/** A dataset containing exactly one finding: a new monthly charge in June. */
const ONE_FINDING = [...HISTORY, ...monthly('DISNEY PLUS', 13.99, '2026-05-14', 2)];

describe('loadAnomalyTransactions', () => {
  it('reads a transaction as itself when it has no splits', async () => {
    const { prisma } = fakePrisma([
      {
        id: 't1',
        date: new Date(Date.UTC(2026, 5, 3)),
        amount: 80,
        category: 'GROCERIES',
        normalizedMerchant: 'SAFEWAY',
      },
    ]);

    await expect(
      loadAnomalyTransactions(prisma, { userId: 'u1', month: '2026-06' }),
    ).resolves.toEqual([
      {
        id: 't1',
        date: '2026-06-03',
        amount: 80,
        category: 'GROCERIES',
        normalizedMerchant: 'SAFEWAY',
      },
    ]);
  });

  it('reads a split transaction as its parts, never as itself as well', async () => {
    const { prisma } = fakePrisma([
      {
        id: 't1',
        date: new Date(Date.UTC(2026, 5, 3)),
        amount: 200,
        category: 'GROCERIES',
        normalizedMerchant: 'COSTCO',
        splits: [
          { category: 'GROCERIES', amount: 120 },
          { category: 'HOUSEHOLD', amount: 80 },
        ],
      },
    ]);

    const rows = await loadAnomalyTransactions(prisma, { userId: 'u1', month: '2026-06' });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount)).toEqual([120, 80]);
    expect(rows.map((r) => r.category)).toEqual(['GROCERIES', 'HOUSEHOLD']);
  });

  it('attributes a refund to the category of the purchase it offsets', async () => {
    const { prisma } = fakePrisma([
      {
        id: 't1',
        date: new Date(Date.UTC(2026, 5, 3)),
        amount: -128.9,
        category: 'REFUND',
        normalizedMerchant: 'ZARA',
        refundFor: { category: 'SHOPPING' },
      },
    ]);

    const [row] = await loadAnomalyTransactions(prisma, { userId: 'u1', month: '2026-06' });
    expect(row).toMatchObject({ amount: -128.9, category: 'SHOPPING' });
  });

  it('leaves an unlinked refund in REFUND, where it is ignored rather than guessed at', async () => {
    const { prisma } = fakePrisma([
      {
        id: 't1',
        date: new Date(Date.UTC(2026, 5, 3)),
        amount: -40,
        category: 'REFUND',
        normalizedMerchant: 'ZARA',
        refundFor: null,
      },
    ]);

    const [row] = await loadAnomalyTransactions(prisma, { userId: 'u1', month: '2026-06' });
    expect(row.category).toBe('REFUND');
  });

  it('stops at the end of the month being analysed', async () => {
    const { prisma } = fakePrisma([
      {
        id: 'inside',
        date: new Date(Date.UTC(2026, 5, 30)),
        amount: 10,
        category: 'DINING',
        normalizedMerchant: 'A',
      },
      {
        id: 'after',
        date: new Date(Date.UTC(2026, 6, 1)),
        amount: 10,
        category: 'DINING',
        normalizedMerchant: 'B',
      },
    ]);

    const rows = await loadAnomalyTransactions(prisma, { userId: 'u1', month: '2026-06' });
    expect(rows.map((r) => r.id)).toEqual(['inside']);
  });
});

describe('refreshAnomalies', () => {
  it('writes the findings for the month', async () => {
    const { prisma, flags } = fakePrisma(ONE_FINDING);

    const summary = await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });

    expect(summary).toMatchObject({ month: '2026-06', detected: 1, created: 1, updated: 0 });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      userId: 'u1',
      month: '2026-06',
      type: 'NEW_RECURRING_CHARGE',
      transactionId: 'DISNEY PLUS-1',
    });
    expect(flags[0].explanation).toContain('DISNEY PLUS');
  });

  it('is idempotent — a second pass updates rather than duplicates', async () => {
    const { prisma, flags } = fakePrisma(ONE_FINDING);

    await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });
    const firstId = flags[0].id;
    const second = await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });

    expect(second).toMatchObject({ detected: 1, created: 0, updated: 1, cleared: 0 });
    expect(flags).toHaveLength(1);
    expect(flags[0].id).toBe(firstId);
  });

  it('clears a flag the data no longer supports', async () => {
    const harness = fakePrisma(ONE_FINDING);
    await refreshAnomalies(harness.prisma, { userId: 'u1', month: '2026-06' });
    expect(harness.flags).toHaveLength(1);

    // The charge is deleted, or recategorized, or was a duplicate: whatever the
    // reason, the finding is gone and the flag should go with it.
    harness.setTransactions(HISTORY);
    const summary = await refreshAnomalies(harness.prisma, { userId: 'u1', month: '2026-06' });

    expect(summary).toMatchObject({ detected: 0, created: 0, cleared: 1 });
    expect(harness.flags).toEqual([]);
  });

  it('does not clear another month-s flags while refreshing this one', async () => {
    const harness = fakePrisma(ONE_FINDING);
    await refreshAnomalies(harness.prisma, { userId: 'u1', month: '2026-06' });

    const summary = await refreshAnomalies(harness.prisma, { userId: 'u1', month: '2026-07' });

    expect(summary).toMatchObject({ month: '2026-07', detected: 0, cleared: 0 });
    expect(harness.flags).toHaveLength(1);
    expect(harness.flags[0].month).toBe('2026-06');
  });

  it('keeps a dismissed flag even once the finding behind it has gone', async () => {
    const harness = fakePrisma(ONE_FINDING);
    const { prisma, flags } = harness;
    await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });

    await dismissInsight(prisma, { id: flags[0].id, userId: 'u1' });

    // Re-detect with the charge removed: the finding disappears, the dismissal
    // must not, or the next pass would put it back on the dashboard.
    harness.setTransactions(HISTORY);
    const summary = await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });

    expect(summary).toMatchObject({ detected: 0, cleared: 0 });
    expect(flags).toHaveLength(1);
    expect(flags[0].dismissedAt).toBeInstanceOf(Date);
  });

  it('leaves another user-s flags alone', async () => {
    const { prisma, flags } = fakePrisma(ONE_FINDING);
    flags.push({
      id: 'other',
      userId: 'u2',
      month: '2026-06',
      fingerprint: 'CATEGORY_SPEND_SPIKE:DINING:2026-06',
      type: 'CATEGORY_SPEND_SPIKE',
      severity: 'HIGH',
      explanation: 'not mine',
      transactionId: null,
      dismissedAt: null,
      createdAt: new Date(),
    });

    await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });

    expect(flags.filter((f) => f.userId === 'u2')).toHaveLength(1);
  });
});

describe('listInsights', () => {
  let harness: ReturnType<typeof fakePrisma>;

  beforeEach(() => {
    harness = fakePrisma();
    const base = {
      userId: 'u1',
      month: '2026-06',
      transactionId: null,
      dismissedAt: null,
      createdAt: new Date(),
    };
    harness.flags.push(
      {
        id: 'c',
        fingerprint: 'c',
        type: 'UNUSUAL_AMOUNT',
        severity: 'LOW',
        explanation: 'c',
        ...base,
      },
      {
        id: 'a',
        fingerprint: 'a',
        type: 'CATEGORY_SPEND_SPIKE',
        severity: 'HIGH',
        explanation: 'a',
        ...base,
      },
      {
        id: 'b',
        fingerprint: 'b',
        type: 'UNUSUAL_AMOUNT',
        severity: 'MEDIUM',
        explanation: 'b',
        ...base,
      },
    );
  });

  it('returns the most severe finding first', async () => {
    const insights = await listInsights(harness.prisma, { userId: 'u1', month: '2026-06' });
    expect(insights.map((i) => i.severity)).toEqual(['HIGH', 'MEDIUM', 'LOW']);
  });

  it('leaves out anything the user has dismissed', async () => {
    await dismissInsight(harness.prisma, { id: 'a', userId: 'u1' });
    const insights = await listInsights(harness.prisma, { userId: 'u1', month: '2026-06' });
    expect(insights.map((i) => i.id)).toEqual(['b', 'c']);
  });
});

describe('dismissInsight', () => {
  it('reports that nothing was dismissed rather than pretending', async () => {
    const { prisma } = fakePrisma();
    await expect(dismissInsight(prisma, { id: 'nope', userId: 'u1' })).resolves.toBe(false);
  });

  it('will not dismiss another user-s flag', async () => {
    const { prisma, flags } = fakePrisma();
    flags.push({
      id: 'theirs',
      userId: 'u2',
      month: '2026-06',
      fingerprint: 'f',
      type: 'UNUSUAL_AMOUNT',
      severity: 'LOW',
      explanation: '',
      transactionId: null,
      dismissedAt: null,
      createdAt: new Date(),
    });

    await expect(dismissInsight(prisma, { id: 'theirs', userId: 'u1' })).resolves.toBe(false);
    expect(flags[0].dismissedAt).toBeNull();
  });

  it('is not fooled twice by the same id', async () => {
    const { prisma, flags } = fakePrisma(ONE_FINDING);
    await refreshAnomalies(prisma, { userId: 'u1', month: '2026-06' });

    await expect(dismissInsight(prisma, { id: flags[0].id, userId: 'u1' })).resolves.toBe(true);
    await expect(dismissInsight(prisma, { id: flags[0].id, userId: 'u1' })).resolves.toBe(false);
  });
});
