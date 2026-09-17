/**
 * Range totals, against a real database and the real seed dataset.
 *
 * The endpoint is an arithmetic claim, and the arithmetic is done by Postgres
 * in a FILTER-ed aggregate. A mocked Prisma could show that the handler runs a
 * query; it could not show that the query adds up. So this suite loads the
 * Phase 1 synthetic dataset — the same rows `npx prisma db seed` produces — and
 * checks three windows two independent ways:
 *
 *   1. against figures worked out by hand from the rows (written out below, so
 *      the test states the claim rather than echoing whatever the code said)
 *   2. against a plain reduce over `generateDataset()` in this process, which
 *      shares no code with the SQL and sums in integer paise
 *
 * Skips when no DATABASE_URL is configured; CI runs it against a service
 * container (see .github/workflows/ci.yml).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateDataset } from '../../prisma/seed-data';
import { seedSyntheticDataset } from '../../prisma/seed-dataset';
import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../services/auth/tokens';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'range-totals@fintrack.test';
const OTHER_EMAIL = 'range-totals-other@fintrack.test';

let prisma: PrismaClient;
let auth: { Authorization: string };
let accountIds: string[];

/**
 * 23 April 2026 — the busiest single day in the dataset, and one with money
 * moving both ways.
 *
 * Seven debits: 179.71 + 878.95 + 398.80 + 295.24 + 1581.23 + 951.35 + 4214.25
 *               = 8,499.53
 * One credit:   4,599.00 (a NIKE.COM refund)
 * Net:          8,499.53 - 4,599.00 = 3,900.53
 */
const DAY = {
  date: '2026-04-23',
  totalDebits: 8499.53,
  totalCredits: 4599,
  net: 3900.53,
  transactionCount: 8,
};

/**
 * June 2026, a complete calendar month in the middle of the window.
 *
 * The debit side grew in Phase 19, which added a ₹18,450 instalment and two
 * SIPs to every month of the fixture (and, in June, the second of the two
 * gold-loan decoy payments).
 */
const MONTH = {
  month: '2026-06',
  totalDebits: 218217.09,
  totalCredits: 234010.1,
  // Still negative: salary landing makes June a month where more arrived.
  net: -15793.01,
  transactionCount: 115,
};

/** Q2 2026, as the client's "This Quarter" chip would ask for it. */
const CUSTOM = {
  startDate: '2026-04-01',
  endDate: '2026-06-30',
  totalDebits: 735085.65,
  totalCredits: 645525.51,
  net: 89560.14,
  transactionCount: 379,
};

/**
 * The same figures from the generator, summed in integer paise.
 *
 * Shares nothing with the SQL but the source rows, so agreement between the two
 * is evidence rather than a tautology — and floats never accumulate, because
 * nothing is added as a float.
 */
function expected(from: string, to: string) {
  let debits = 0;
  let credits = 0;
  let count = 0;

  for (const row of generateDataset()) {
    if (row.date < from || row.date > to) continue;
    const paise = Math.round(row.amount * 100);
    if (paise > 0) debits += paise;
    else if (paise < 0) credits += -paise;
    count += 1;
  }

  return {
    totalDebits: debits / 100,
    totalCredits: credits / 100,
    net: (debits - credits) / 100,
    transactionCount: count,
  };
}

const totals = (query: Record<string, string>) =>
  request(app).get('/api/totals').query(query).set(auth);

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();

  const seeded = await seedSyntheticDataset(prisma, { email: EMAIL, name: 'Range Totals' });
  auth = { Authorization: `Bearer ${signAccessToken(seeded.userId)}` };
  accountIds = (
    await prisma.account.findMany({ where: { userId: seeded.userId }, select: { id: true } })
  ).map((a) => a.id);
}, 120000);

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('GET /api/totals', () => {
  it('adds up one day', async () => {
    const response = await totals({ range: 'daily', date: DAY.date }).expect(200);

    expect(response.body).toMatchObject({
      totalDebits: DAY.totalDebits,
      totalCredits: DAY.totalCredits,
      net: DAY.net,
      transactionCount: DAY.transactionCount,
    });
    // And the hand-worked figures are what the generator actually produces.
    expect(expected(DAY.date, DAY.date)).toEqual({
      totalDebits: DAY.totalDebits,
      totalCredits: DAY.totalCredits,
      net: DAY.net,
      transactionCount: DAY.transactionCount,
    });
  });

  it('adds up one month', async () => {
    const response = await totals({ range: 'monthly', month: MONTH.month }).expect(200);

    expect(response.body).toMatchObject({
      totalDebits: MONTH.totalDebits,
      totalCredits: MONTH.totalCredits,
      net: MONTH.net,
      transactionCount: MONTH.transactionCount,
    });
    expect(expected('2026-06-01', '2026-06-30')).toMatchObject({
      totalDebits: MONTH.totalDebits,
      net: MONTH.net,
    });
  });

  it('adds up a custom range, end date included', async () => {
    const response = await totals({
      range: 'custom',
      startDate: CUSTOM.startDate,
      endDate: CUSTOM.endDate,
    }).expect(200);

    expect(response.body).toMatchObject({
      totalDebits: CUSTOM.totalDebits,
      totalCredits: CUSTOM.totalCredits,
      net: CUSTOM.net,
      transactionCount: CUSTOM.transactionCount,
    });
    expect(expected(CUSTOM.startDate, CUSTOM.endDate)).toMatchObject({
      totalDebits: CUSTOM.totalDebits,
      transactionCount: CUSTOM.transactionCount,
    });
  });

  it('counts the last day of a custom range', async () => {
    // The off-by-one this endpoint is most likely to have: an exclusive `to`
    // built straight from the caller's inclusive end date.
    const upToThe22nd = await totals({
      range: 'custom',
      startDate: '2026-04-01',
      endDate: '2026-04-22',
    }).expect(200);
    const upToThe23rd = await totals({
      range: 'custom',
      startDate: '2026-04-01',
      endDate: '2026-04-23',
    }).expect(200);

    expect(upToThe23rd.body.transactionCount - upToThe22nd.body.transactionCount).toBe(
      DAY.transactionCount,
    );
    expect(
      Math.round((upToThe23rd.body.totalDebits - upToThe22nd.body.totalDebits) * 100) / 100,
    ).toBe(DAY.totalDebits);
  });

  it('echoes the window it actually used', async () => {
    const day = await totals({ range: 'daily', date: DAY.date }).expect(200);
    expect(day.body.range).toEqual({
      kind: 'daily',
      startDate: DAY.date,
      endDate: DAY.date,
      month: null,
    });

    const month = await totals({ range: 'monthly', month: '2026-06' }).expect(200);
    expect(month.body.range).toEqual({
      kind: 'monthly',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      month: '2026-06',
    });
  });

  it('net is debits minus credits, in the same direction as every stored amount', async () => {
    // Positive means more left than arrived. The client colours by this sign
    // alone, so it has to mean the same thing here as it does on a transaction.
    const response = await totals({ range: 'daily', date: DAY.date }).expect(200);
    expect(response.body.net).toBe(
      Math.round((response.body.totalDebits - response.body.totalCredits) * 100) / 100,
    );
    expect(response.body.net).toBeGreaterThan(0);

    const june = await totals({ range: 'monthly', month: '2026-06' }).expect(200);
    expect(june.body.net).toBeLessThan(0);
  });

  it('splits the total between the two accounts and loses nothing', async () => {
    const all = await totals({ range: 'monthly', month: MONTH.month }).expect(200);
    const perAccount = await Promise.all(
      accountIds.map((accountId) =>
        totals({ range: 'monthly', month: MONTH.month, accountId }).expect(200),
      ),
    );

    const sum = (key: 'totalDebits' | 'totalCredits' | 'transactionCount') =>
      perAccount.reduce((acc, r) => acc + r.body[key], 0);

    expect(Math.round(sum('totalDebits') * 100) / 100).toBe(all.body.totalDebits);
    expect(Math.round(sum('totalCredits') * 100) / 100).toBe(all.body.totalCredits);
    expect(sum('transactionCount')).toBe(all.body.transactionCount);
    // And each account really is a subset, not a copy of the whole.
    perAccount.forEach((r) =>
      expect(r.body.transactionCount).toBeLessThan(all.body.transactionCount),
    );
  });

  it('answers zeros for a window with nothing in it', async () => {
    // Not an error and not a 404: "you spent nothing that day" is an answer.
    const response = await totals({ range: 'daily', date: '2025-01-01' }).expect(200);
    expect(response.body).toMatchObject({
      totalDebits: 0,
      totalCredits: 0,
      net: 0,
      transactionCount: 0,
    });
  });

  it('refuses another user account rather than quietly ignoring the filter', async () => {
    const other = await prisma.user.create({
      data: {
        email: OTHER_EMAIL,
        accounts: { create: [{ name: 'Theirs', type: 'CHECKING' }] },
      },
      select: { accounts: { select: { id: true } } },
    });

    await totals({ range: 'monthly', month: MONTH.month, accountId: other.accounts[0].id }).expect(
      404,
    );
  });

  it('rejects a range it cannot resolve', async () => {
    await totals({ range: 'daily' }).expect(400);
    await totals({ range: 'monthly' }).expect(400);
    await totals({ range: 'custom', startDate: '2026-04-01' }).expect(400);
    await totals({ range: 'custom', startDate: '2026-06-30', endDate: '2026-04-01' }).expect(400);
    await totals({ range: 'weekly' }).expect(400);
    await totals({ range: 'daily', date: '23-04-2026' }).expect(400);
  });

  it('needs a session', async () => {
    await request(app).get('/api/totals').query({ range: 'daily', date: DAY.date }).expect(401);
  });
});
