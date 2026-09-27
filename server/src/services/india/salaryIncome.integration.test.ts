/**
 * Salary credits categorized as income, against a real database.
 *
 * The unit tests prove the decision; this proves the queries — that the
 * update touches exactly the uncategorized credits from the employer, and
 * that a person's own correction survives it. Skips without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../../db';
import type { PrismaClient } from '../../generated/prisma/client';
import { categorizeSalaryCredits } from './salaryIncome';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const EMAIL = 'salary-income@fintrack.test';

let prisma: PrismaClient;
let userId: string;
let summary: Awaited<ReturnType<typeof categorizeSalaryCredits>>;

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await prisma.user.deleteMany({ where: { email: EMAIL } });

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      accounts: { create: [{ name: 'HDFC Savings', type: 'SAVINGS' }] },
    },
    include: { accounts: true },
  });
  userId = user.id;
  const accountId = user.accounts[0].id;

  // Invented: an NEFT salary naming only the employer, June to September; the
  // September credit was already categorized by hand, as a bonus the person
  // chose to file under BUSINESS. And one ordinary purchase.
  const rows: [
    string,
    number,
    'UNCATEGORIZED' | 'BUSINESS' | 'DINING',
    'RULE' | 'MANUAL',
    string,
  ][] = [
    ['2026-06-01', -185000, 'UNCATEGORIZED', 'RULE', 'NORTHWIND LABS'],
    ['2026-07-01', -185000, 'UNCATEGORIZED', 'RULE', 'NORTHWIND LABS'],
    ['2026-08-01', -186500, 'UNCATEGORIZED', 'RULE', 'NORTHWIND LABS'],
    ['2026-09-01', -185000, 'BUSINESS', 'MANUAL', 'NORTHWIND LABS'],
    ['2026-08-03', 450, 'DINING', 'RULE', 'SWIGGY'],
  ];
  for (const [date, amount, category, source, merchant] of rows) {
    await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(`${date}T00:00:00Z`),
        description: `NEFT CR-CITI0100000-${merchant}-A SAMPLE PERSON`,
        rawMerchant: merchant,
        normalizedMerchant: merchant,
        amount: amount.toFixed(2),
        category,
        source,
        confidence: source === 'MANUAL' ? 1 : 0,
      },
    });
  }

  summary = await categorizeSalaryCredits(prisma, { userId });
}, 30000);

afterAll(async () => {
  if (!hasDatabase) return;
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('categorizeSalaryCredits against a real database', () => {
  it('recognises the employer and files its uncategorized credits as income', async () => {
    expect(summary).toEqual({ payers: ['NORTHWIND LABS'], categorized: 3 });
    const incomes = await prisma.transaction.findMany({
      where: { account: { userId }, category: 'INCOME' },
      select: { amount: true, source: true },
    });
    expect(incomes).toHaveLength(3);
    expect(incomes.every((t) => t.source === 'RULE')).toBe(true);
  });

  it("leaves a person's own correction exactly as they made it", async () => {
    const manual = await prisma.transaction.findFirst({
      where: { account: { userId }, source: 'MANUAL' },
    });
    expect(manual?.category).toBe('BUSINESS');
  });

  it('touches nothing that is not a credit from the employer', async () => {
    const swiggy = await prisma.transaction.findFirst({
      where: { account: { userId }, normalizedMerchant: 'SWIGGY' },
    });
    expect(swiggy?.category).toBe('DINING');
  });

  it('is idempotent: a second pass finds nothing left to do', async () => {
    expect((await categorizeSalaryCredits(prisma, { userId })).categorized).toBe(0);
  });
});
