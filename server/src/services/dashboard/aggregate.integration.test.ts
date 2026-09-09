/**
 * The aggregation rules of PROJECT_CONTEXT.md §5 and §8, against a real database.
 *
 * These are the three rules that decide whether the headline numbers are right,
 * and all three live in SQL rather than TypeScript:
 *
 *   1. TRANSFER is excluded from spend *and* from income (§8 case 1).
 *   2. A REFUND nets against the category of the purchase it offsets, instead
 *      of sitting in a bucket of its own while the purchase stays at full price
 *      (§8 case 2).
 *   3. A split transaction is counted by its parts, never by its parent as well
 *      (§8 case 3).
 *
 * A mocked Prisma cannot test any of that — it would only prove the query was
 * called. So this suite builds a fixture in Postgres and reads the real result.
 * It skips when no DATABASE_URL is configured; CI runs it against a service
 * container (see .github/workflows/ci.yml).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../../db';
import type { PrismaClient } from '../../generated/prisma/client';
import type { Category } from '../../generated/prisma/enums';
import { aggregateDashboard, type DashboardResult } from './aggregate';
import { comparisonWindow, monthWindow } from './window';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const MONTH = '2026-06';
const EMAIL = 'aggregate-integration@fintrack.test';

interface Row {
  day: number;
  description: string;
  merchant: string;
  amount: number;
  category: Category;
  account?: 'checking' | 'credit';
  /** Null posted date means still pending (§8 case 6). */
  pending?: boolean;
  splits?: { category: Category; amount: number }[];
}

/**
 * One month containing every §8 case that changes a total.
 *
 * Chosen so each assertion below has exactly one cause: if `spend` is wrong,
 * the category totals say which rule broke.
 */
const ROWS: Row[] = [
  // Ordinary spending.
  {
    day: 2,
    description: 'WHOLE FOODS 388',
    merchant: 'WHOLE FOODS',
    amount: 100,
    category: 'GROCERIES',
  },
  {
    day: 3,
    description: 'SQ *JOES COFFEE',
    merchant: 'JOES COFFEE',
    amount: 40,
    category: 'DINING',
  },

  // §8 case 6 — pending, no posted date. Still the user's money.
  {
    day: 27,
    description: 'SWEETGREEN 4412',
    merchant: 'SWEETGREEN',
    amount: 60,
    category: 'DINING',
    pending: true,
  },

  // §8 case 1 — a card payment moving money between the user's own accounts.
  {
    day: 5,
    description: 'CARD PAYMENT THANK YOU',
    merchant: 'CARD PAYMENT',
    amount: 500,
    category: 'TRANSFER',
  },
  {
    day: 5,
    description: 'PAYMENT RECEIVED',
    merchant: 'CARD PAYMENT',
    amount: -500,
    category: 'TRANSFER',
    account: 'credit',
  },

  // §8 case 9 — a peer-to-peer round trip. Out and back, not spending.
  {
    day: 8,
    description: 'VENMO PAYMENT 1042',
    merchant: 'VENMO',
    amount: 50,
    category: 'TRANSFER',
  },
  { day: 10, description: 'VENMO CASHOUT', merchant: 'VENMO', amount: -50, category: 'TRANSFER' },

  // §8 case 2 — a purchase and the refund that offsets it.
  { day: 6, description: 'ZARA 0921', merchant: 'ZARA', amount: 200, category: 'SHOPPING' },
  { day: 20, description: 'ZARA 0921 RETURN', merchant: 'ZARA', amount: -80, category: 'REFUND' },

  // §8 case 3 — one charge across two categories.
  {
    day: 12,
    description: 'COSTCO WHSE 1122',
    merchant: 'COSTCO',
    amount: 300,
    category: 'SHOPPING',
    splits: [
      { category: 'GROCERIES', amount: 180 },
      { category: 'SHOPPING', amount: 120 },
    ],
  },

  // §8 case 7 — a foreign purchase and its fee, as two rows.
  {
    day: 15,
    description: 'TRENITALIA 8841',
    merchant: 'TRENITALIA',
    amount: 120,
    category: 'TRAVEL',
  },
  {
    day: 15,
    description: 'FOREIGN TRANSACTION FEE',
    merchant: 'FOREIGN TRANSACTION FEE',
    amount: 3.6,
    category: 'FEES_INTEREST',
  },

  // §8 case 11 — income from two sources, at different amounts.
  {
    day: 1,
    description: 'ACME CORP PAYROLL',
    merchant: 'ACME CORP PAYROLL',
    amount: -3000,
    category: 'INCOME',
  },
  {
    day: 18,
    description: 'STRIPE TRANSFER FREELANCE',
    merchant: 'STRIPE',
    amount: -450,
    category: 'INCOME',
  },
];

/** Spend the dashboard should report: purchases only, no transfers, refund netted. */
const EXPECTED_SPEND = 100 + 40 + 60 + (200 - 80) + 300 + 120 + 3.6;
const EXPECTED_INCOME = 3000 + 450;

let prisma: PrismaClient;
let userId: string;
let result: DashboardResult;

async function seedFixture() {
  await prisma.user.deleteMany({ where: { email: EMAIL } });

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: 'Integration Fixture',
      passwordHash: 'not-a-real-hash',
      accounts: {
        create: [
          { name: 'Fixture Checking', type: 'CHECKING' },
          { name: 'Fixture Credit', type: 'CREDIT_CARD' },
        ],
      },
    },
    include: { accounts: true },
  });

  const byName = new Map(user.accounts.map((a) => [a.name, a.id]));
  const checking = byName.get('Fixture Checking')!;
  const credit = byName.get('Fixture Credit')!;
  const day = (n: number) => new Date(Date.UTC(2026, 5, n));

  const created = new Map<string, string>();
  for (const row of ROWS) {
    const transaction = await prisma.transaction.create({
      data: {
        accountId: row.account === 'credit' ? credit : checking,
        date: day(row.day),
        postedDate: row.pending ? null : day(row.day + 1),
        description: row.description,
        rawMerchant: row.description,
        normalizedMerchant: row.merchant,
        amount: row.amount.toFixed(2),
        category: row.category,
        confidence: 1,
        source: 'RULE',
        ...(row.splits
          ? {
              splits: {
                create: row.splits.map((split) => ({
                  category: split.category,
                  amount: split.amount.toFixed(2),
                  note: 'fixture',
                })),
              },
            }
          : {}),
      },
    });
    created.set(row.description, transaction.id);
  }

  // The refund link lives on the purchase and points at the refund (Phase 1).
  await prisma.transaction.update({
    where: { id: created.get('ZARA 0921')! },
    data: { linkedRefundId: created.get('ZARA 0921 RETURN')! },
  });
  // The transfer link lives on the outgoing leg.
  await prisma.transaction.update({
    where: { id: created.get('CARD PAYMENT THANK YOU')! },
    data: { transferPairId: created.get('PAYMENT RECEIVED')! },
  });

  return user.id;
}

const amountFor = (category: Category): number =>
  result.byCategory.find((row) => row.category === category)?.amount ?? 0;

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  userId = await seedFixture();

  const window = monthWindow(MONTH);
  const previous = comparisonWindow(window, MONTH);
  result = await aggregateDashboard(prisma, {
    userId,
    from: window.from,
    to: window.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    granularity: 'daily',
  });
}, 30000);

afterAll(async () => {
  if (!hasDatabase) return;
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('aggregateDashboard against a real database', () => {
  it('reports the spend the fixture actually contains', () => {
    expect(result.totals.spend).toBeCloseTo(EXPECTED_SPEND, 2);
  });

  it('reports income from every source, however irregular (§8 case 11)', () => {
    expect(result.totals.income).toBeCloseTo(EXPECTED_INCOME, 2);
    // Two sources at different amounts, both counted.
    expect(amountFor('INCOME')).toBeCloseTo(-EXPECTED_INCOME, 2);
  });

  it('excludes transfers from spend and from income alike (§8 case 1)', () => {
    // Both legs of the card payment are in the data...
    expect(amountFor('TRANSFER')).toBe(0);
    // ...and neither the $500 out nor the $500 back moved either total.
    expect(result.totals.spend).toBeCloseTo(EXPECTED_SPEND, 2);
    expect(result.totals.income).toBeCloseTo(EXPECTED_INCOME, 2);
    expect(result.byCategory.map((row) => row.category)).not.toContain('TRANSFER');
  });

  it('does not read a peer-to-peer round trip as spending (§8 case 9)', () => {
    // The $50 out and the $50 back are both TRANSFER, so neither is spend.
    // If either leaked in, spend would be off by exactly 50.
    expect(result.totals.spend).not.toBeCloseTo(EXPECTED_SPEND + 50, 2);
    expect(result.totals.spend).toBeCloseTo(EXPECTED_SPEND, 2);
  });

  it('nets a refund against the category it came from, not a bucket of its own (§8 case 2)', () => {
    // $200 of shopping, $80 returned, $120 of shopping. Plus the $120 split part.
    expect(amountFor('SHOPPING')).toBeCloseTo(120 + 120, 2);
    expect(result.byCategory.map((row) => row.category)).not.toContain('REFUND');
  });

  it('counts a split by its parts and never also by its parent (§8 case 3)', () => {
    // $100 of groceries plus the $180 grocery half of the Costco charge. The
    // $300 parent contributes nothing of its own.
    expect(amountFor('GROCERIES')).toBeCloseTo(100 + 180, 2);
    // Counting the parent as well would add $300 to spend.
    expect(result.totals.spend).not.toBeCloseTo(EXPECTED_SPEND + 300, 2);
  });

  it('counts a pending transaction, which is money already gone (§8 case 6)', () => {
    // The pending Sweetgreen charge is $60 of the $100 of dining.
    expect(amountFor('DINING')).toBeCloseTo(40 + 60, 2);
  });

  it('keeps a foreign transaction fee as its own line (§8 case 7)', () => {
    expect(amountFor('TRAVEL')).toBeCloseTo(120, 2);
    expect(amountFor('FEES_INTEREST')).toBeCloseTo(3.6, 2);
  });

  it('counts each transaction once, splits and refunds included', () => {
    // 15 rows in, and every one of them accounted for exactly once.
    expect(result.totals.transactions).toBe(ROWS.length);
  });

  it('adds the category totals back up to the spend it reported', () => {
    const fromCategories = result.byCategory
      .filter((row) => row.category !== 'INCOME')
      .reduce((sum, row) => sum + row.amount, 0);
    expect(fromCategories).toBeCloseTo(result.totals.spend, 2);
  });

  it('ranks merchants by what was actually spent at them', () => {
    expect(result.topMerchants[0]).toMatchObject({ merchant: 'COSTCO', amount: 300 });
    // The transfer merchants are not spending and never appear here.
    expect(result.topMerchants.map((m) => m.merchant)).not.toContain('CARD PAYMENT');
    expect(result.topMerchants.map((m) => m.merchant)).not.toContain('VENMO');
  });
});
