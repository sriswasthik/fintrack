import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../../generated/prisma/client';
import { categorizeSalaryCredits } from './salaryIncome';

// Every name, handle and amount is invented.
interface Row {
  id: string;
  date: Date;
  amount: number;
  category: string;
  normalizedMerchant: string;
  counterpartyRaw: string | null;
  upiVpa: string | null;
}

const row = (
  id: string,
  iso: string,
  amount: number,
  merchant: string,
  extra: Partial<Row> = {},
): Row => ({
  id,
  date: new Date(`${iso}T00:00:00Z`),
  amount,
  category: 'UNCATEGORIZED',
  normalizedMerchant: merchant,
  counterpartyRaw: null,
  upiVpa: null,
  ...extra,
});

/** Three months of an NEFT salary that names only the employer. */
const salaryMonths = [
  row('s1', '2026-06-01', -185000, 'NORTHWIND LABS'),
  row('s2', '2026-07-01', -185000, 'NORTHWIND LABS'),
  row('s3', '2026-08-01', -186500, 'NORTHWIND LABS'),
];

const db = { findMany: vi.fn(), updateMany: vi.fn() };
const prisma = {
  transaction: { findMany: db.findMany, updateMany: db.updateMany },
} as unknown as PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
  db.updateMany.mockResolvedValue({ count: 3 });
});

describe('categorizeSalaryCredits', () => {
  it('marks an employer paying the same amount on the same day each month as income', async () => {
    db.findMany.mockResolvedValue([
      ...salaryMonths,
      row('d1', '2026-06-03', 450, 'SWIGGY'),
      row('d2', '2026-07-03', 380, 'SWIGGY'),
    ]);

    const summary = await categorizeSalaryCredits(prisma, { userId: 'u1' });

    expect(summary).toEqual({ payers: ['NORTHWIND LABS'], categorized: 3 });
    expect(db.updateMany).toHaveBeenCalledWith({
      where: {
        account: { userId: 'u1' },
        normalizedMerchant: { in: ['NORTHWIND LABS'] },
        amount: { lt: 0 },
        category: 'UNCATEGORIZED',
        source: 'RULE',
      },
      data: { category: 'INCOME', confidence: 0.9 },
    });
  });

  it('only ever changes uncategorized, rule-sourced credits', async () => {
    // The where clause is the guarantee: a person's own correction (MANUAL)
    // and anything a rule already settled can never match it.
    db.findMany.mockResolvedValue(salaryMonths);
    await categorizeSalaryCredits(prisma, { userId: 'u1' });
    const { where } = db.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({ category: 'UNCATEGORIZED', source: 'RULE', amount: { lt: 0 } });
  });

  it('never reads transfers or refunds as evidence of a salary', async () => {
    db.findMany.mockResolvedValue([]);
    await categorizeSalaryCredits(prisma, { userId: 'u1' });
    expect(db.findMany.mock.calls[0][0].where).toMatchObject({
      account: { userId: 'u1' },
      category: { notIn: ['TRANSFER', 'REFUND'] },
    });
  });

  it('leaves a person paying the same amount every month for the person to classify', async () => {
    const fromFamily = (id: string, iso: string) =>
      row(id, iso, -25000, 'RAMESH KUMAR', {
        counterpartyRaw: 'Ramesh Kumar',
        upiVpa: '9876543210@ybl',
      });
    db.findMany.mockResolvedValue([
      fromFamily('p1', '2026-06-05'),
      fromFamily('p2', '2026-07-05'),
      fromFamily('p3', '2026-08-05'),
    ]);

    expect(await categorizeSalaryCredits(prisma, { userId: 'u1' })).toEqual({
      payers: [],
      categorized: 0,
    });
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('does not guess from a single month', async () => {
    // Three consecutive months is where "this is their income" stops being a guess.
    db.findMany.mockResolvedValue([salaryMonths[0]]);
    expect(await categorizeSalaryCredits(prisma, { userId: 'u1' })).toEqual({
      payers: [],
      categorized: 0,
    });
  });

  it('does nothing for a person with no transactions', async () => {
    db.findMany.mockResolvedValue([]);
    expect(await categorizeSalaryCredits(prisma, { userId: 'u1' })).toEqual({
      payers: [],
      categorized: 0,
    });
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});
