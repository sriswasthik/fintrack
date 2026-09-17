/**
 * The India insights endpoint, against a real database and the real seed.
 *
 * The detectors have their own suites; what this one proves is the wiring —
 * that the route loads enough history, hands the detectors rows in the shape
 * they expect, scopes them to the caller, and answers with all five features.
 *
 * Skips when no DATABASE_URL is configured; CI runs it against a service
 * container (see .github/workflows/ci.yml).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedSyntheticDataset } from '../../prisma/seed-dataset';
import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../services/auth/tokens';
import { applyRuleEngine } from '../services/rules/apply';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'india-insights@fintrack.test';
const OTHER_EMAIL = 'india-insights-other@fintrack.test';

let prisma: PrismaClient;
let auth: { Authorization: string };

const india = (query: Record<string, string> = {}) =>
  request(app).get('/api/india').query(query).set(auth);

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();

  const seeded = await seedSyntheticDataset(prisma, { email: EMAIL, name: 'India Insights' });
  // The detectors read `category`, which the seed deliberately leaves
  // UNCATEGORIZED — so the Phase 14 rules have to run for this to mean
  // anything. That is also the end-to-end check that the Phase 19 rows
  // categorize the way the fixture says they do.
  await applyRuleEngine(prisma, { userId: seeded.userId });
  auth = { Authorization: `Bearer ${signAccessToken(seeded.userId)}` };
}, 180000);

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('GET /api/india', () => {
  it('answers with all five features for the month asked about', async () => {
    const { body } = await india({ month: '2026-08' }).expect(200);

    expect(body.month).toBe('2026-08');
    expect(body).toHaveProperty('salary');
    expect(body).toHaveProperty('savings');
    expect(body).toHaveProperty('loans');
    expect(body).toHaveProperty('investments');
    expect(body).toHaveProperty('upcoming');
    expect(body).toHaveProperty('festive');
  });

  it('finds the salary and a savings rate through the real pipeline', async () => {
    const { body } = await india({ month: '2026-08' }).expect(200);

    expect(body.salary).toMatchObject({ payer: 'INFOSYS LTD', creditsPerMonth: 2 });
    expect(body.savings.rate).toBeTypeOf('number');
  });

  it('finds the EMI the rule engine categorized, and not the decoy', async () => {
    const { body } = await india({ month: '2026-08' }).expect(200);

    expect(body.loans.loans.map((l: { merchant: string }) => l.merchant)).toEqual([
      'BAJAJ FINANCE EMI',
    ]);
    expect(body.loans.totalMonthly).toBe(18450);
    expect(body.loans.loans[0].estimate.caveat).toMatch(/^Estimate only\./);
  });

  it('finds both SIPs and what share of income they take', async () => {
    const { body } = await india({ month: '2026-08' }).expect(200);

    expect(body.investments.totalMonthly).toBe(7500);
    expect(body.investments.shareOfIncome).toBeGreaterThan(0);
    expect(body.investments.shareOfIncome).toBeLessThan(1);
  });

  it('predicts next month bills and labels the festive month', async () => {
    const august = await india({ month: '2026-08' }).expect(200);
    expect(august.body.upcoming.bills.length).toBeGreaterThan(0);
    expect(august.body.festive).toBeNull();

    const september = await india({ month: '2026-09' }).expect(200);
    expect(september.body.festive.windows[0].key).toBe('dussehra-diwali');
  });

  it('loads enough history for a twelve-month commitment', async () => {
    // The EMI starts in March. Asked about August, the route has to have loaded
    // March to see six instalments rather than two.
    const { body } = await india({ month: '2026-08' }).expect(200);
    expect(body.loans.loans[0].firstSeen).toBe('2026-03-05');
    expect(body.loans.loans[0].instalmentsObserved).toBe(6);
  });

  it('answers emptily rather than erroring for a user with no data', async () => {
    const other = await prisma.user.create({
      data: { email: OTHER_EMAIL, accounts: { create: [{ name: 'Empty', type: 'CHECKING' }] } },
      select: { id: true },
    });

    const { body } = await request(app)
      .get('/api/india')
      .query({ month: '2026-08' })
      .set({ Authorization: `Bearer ${signAccessToken(other.id)}` })
      .expect(200);

    expect(body.salary).toBeNull();
    expect(body.savings.rate).toBeNull();
    expect(body.loans.loans).toEqual([]);
    expect(body.investments.plans).toEqual([]);
    expect(body.upcoming.bills).toEqual([]);
    expect(body.festive).toBeNull();
  });

  it('refuses another user account rather than ignoring the filter', async () => {
    const other = await prisma.user.findUniqueOrThrow({
      where: { email: OTHER_EMAIL },
      select: { accounts: { select: { id: true } } },
    });
    await india({ month: '2026-08', accountId: other.accounts[0].id }).expect(404);
  });

  it('rejects a month it cannot parse, and needs a session', async () => {
    await india({ month: 'August' }).expect(400);
    await request(app).get('/api/india').expect(401);
  });
});
