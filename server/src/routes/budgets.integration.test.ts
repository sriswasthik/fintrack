/**
 * Budgets, against the real seed dataset (Phase 20).
 *
 * The claim worth testing is that a budget and the dashboard can never tell a
 * person two different things about the same month. So spend is checked
 * against `/api/dashboard` for the same month, category by category — the
 * dashboard's own arithmetic is proven in aggregate.integration.test.ts.
 *
 * Skips when no DATABASE_URL is configured.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedSyntheticDataset } from '../../prisma/seed-dataset';
import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../services/auth/tokens';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'budgets@fintrack.test';
const OTHER_EMAIL = 'budgets-other@fintrack.test';
const MONTH = '2026-06';

let prisma: PrismaClient;
let auth: { Authorization: string };
let otherAuth: { Authorization: string };
let spendBy: Map<string, number>;

interface Progress {
  category: string;
  amount: number;
  spent: number;
  remaining: number;
  percent: number;
  status: 'ok' | 'warning' | 'over';
}

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();

  const seeded = await seedSyntheticDataset(prisma, { email: EMAIL, name: 'Budgets' });
  const other = await prisma.user.create({ data: { email: OTHER_EMAIL } });
  auth = { Authorization: `Bearer ${signAccessToken(seeded.userId)}` };
  otherAuth = { Authorization: `Bearer ${signAccessToken(other.id)}` };

  const dashboard = await request(app)
    .get('/api/dashboard')
    .query({ month: MONTH })
    .set(auth)
    .expect(200);
  spendBy = new Map(
    dashboard.body.byCategory.map((c: { category: string; amount: number }) => [
      c.category,
      c.amount,
    ]),
  );
}, 120000);

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('budgets', () => {
  it('has none to begin with, and says so rather than failing', async () => {
    const response = await request(app)
      .get('/api/budgets')
      .query({ month: MONTH })
      .set(auth)
      .expect(200);
    expect(response.body.budgets).toEqual([]);
    expect(response.body.totals).toMatchObject({ budgeted: 0, spent: 0, over: 0, warning: 0 });
    expect(response.body.monthElapsed).toBe(1);
  });

  it('measures each budget with exactly the spend the dashboard shows', async () => {
    const dining = spendBy.get('DINING')!;
    const shopping = spendBy.get('SHOPPING')!;
    const groceries = spendBy.get('GROCERIES')!;
    expect(dining).toBeGreaterThan(0);

    // One comfortably under, one near the line, one well over.
    await request(app)
      .put('/api/budgets/DINING')
      .set(auth)
      .send({ amount: Math.ceil(dining * 2) })
      .expect(200);
    await request(app)
      .put('/api/budgets/GROCERIES')
      .set(auth)
      .send({ amount: Math.ceil(groceries / 0.9) })
      .expect(200);
    await request(app)
      .put('/api/budgets/SHOPPING')
      .set(auth)
      .send({ amount: Math.floor(shopping / 2) })
      .expect(200);

    const response = await request(app)
      .get('/api/budgets')
      .query({ month: MONTH })
      .set(auth)
      .expect(200);
    const byCategory = new Map<string, Progress>(
      response.body.budgets.map((b: Progress) => [b.category, b]),
    );

    expect(byCategory.get('DINING')).toMatchObject({ spent: dining, status: 'ok' });
    expect(byCategory.get('GROCERIES')).toMatchObject({ spent: groceries, status: 'warning' });
    expect(byCategory.get('SHOPPING')).toMatchObject({ spent: shopping, status: 'over' });
    expect(byCategory.get('SHOPPING')!.remaining).toBeLessThan(0);

    // Most at risk first.
    expect(response.body.budgets[0].category).toBe('SHOPPING');
    expect(response.body.totals).toMatchObject({ over: 1, warning: 1 });
  });

  it('counts what was spent outside any budget, and never income or transfers', async () => {
    const response = await request(app)
      .get('/api/budgets')
      .query({ month: MONTH })
      .set(auth)
      .expect(200);

    const budgeted = new Set(['DINING', 'GROCERIES', 'SHOPPING']);
    const expected = [...spendBy]
      .filter(([category, amount]) => {
        return (
          !budgeted.has(category) &&
          !['INCOME', 'TRANSFER', 'REFUND'].includes(category) &&
          amount > 0
        );
      })
      .reduce((sum, [, amount]) => sum + amount, 0);

    expect(response.body.totals.unbudgetedSpend).toBeCloseTo(expected, 2);
    expect(response.body.totals.unbudgetedSpend).toBeGreaterThan(0);
  });

  it('replaces a budget rather than adding a second one', async () => {
    await request(app).put('/api/budgets/DINING').set(auth).send({ amount: 1234.5 }).expect(200);
    const rows = await prisma.budget.findMany({
      where: { user: { email: EMAIL }, category: 'DINING' },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(1234.5);
  });

  it('removes a budget, and says so when there was none to remove', async () => {
    await request(app).delete('/api/budgets/GROCERIES').set(auth).expect(204);
    await request(app).delete('/api/budgets/GROCERIES').set(auth).expect(404);
  });

  it('is private to its owner', async () => {
    const theirs = await request(app)
      .get('/api/budgets')
      .query({ month: MONTH })
      .set(otherAuth)
      .expect(200);
    expect(theirs.body.budgets).toEqual([]);
    // Deleting "their" DINING budget cannot reach ours.
    await request(app).delete('/api/budgets/DINING').set(otherAuth).expect(404);
  });
});
