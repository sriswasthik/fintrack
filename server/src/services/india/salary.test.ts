import { describe, expect, it } from 'vitest';

import { detectSalary, savingsRate } from './salary';
import type { IndiaTransaction } from './types';

let counter = 0;
/** A credit. Debit-positive, so income is negative. */
const credit = (date: string, payer: string, amount: number): IndiaTransaction => ({
  id: `c${++counter}`,
  date,
  amount: -Math.abs(amount),
  category: 'INCOME',
  normalizedMerchant: payer,
});
const debit = (
  date: string,
  merchant: string,
  amount: number,
  category: IndiaTransaction['category'] = 'SHOPPING',
): IndiaTransaction => ({
  id: `d${++counter}`,
  date,
  amount,
  category,
  normalizedMerchant: merchant,
});

/** A clean monthly payroll: same payer, same day, same money. */
const payroll = (months: string[], day = 28, amount = 85000) =>
  months.map((m) => credit(`${m}-${String(day).padStart(2, '0')}`, 'ACME CORP', amount));

describe('it fires on a real salary', () => {
  it('finds a monthly payroll', () => {
    const salary = detectSalary(payroll(['2026-04', '2026-05', '2026-06']), { month: '2026-06' });

    expect(salary).toMatchObject({
      payer: 'ACME CORP',
      monthlyAmount: 85000,
      payDay: 28,
      creditsPerMonth: 1,
      presentInMonth: true,
    });
    expect(salary?.months).toHaveLength(3);
  });

  it('finds a semi-monthly payroll, which is two credits and one salary', () => {
    // The case a per-transaction detector misses entirely: paid twice a month,
    // neither credit on a monthly cadence, but the monthly total rock steady.
    const rows = ['2026-04', '2026-05', '2026-06'].flatMap((m) => [
      credit(`${m}-15`, 'INFOSYS LTD', 60000),
      credit(`${m}-30`, 'INFOSYS LTD', 60000),
    ]);

    expect(detectSalary(rows, { month: '2026-06' })).toMatchObject({
      payer: 'INFOSYS LTD',
      monthlyAmount: 120000,
      payDay: 15,
      creditsPerMonth: 2,
    });
  });

  it('tolerates overtime inside the 10% band', () => {
    const rows = [
      credit('2026-04-28', 'ACME CORP', 85000),
      credit('2026-05-28', 'ACME CORP', 90000),
      credit('2026-06-28', 'ACME CORP', 82000),
    ];
    expect(detectSalary(rows, { month: '2026-06' })?.monthlyAmount).toBe(85000);
  });

  it('survives a bonus month instead of being broken by it', () => {
    // An extra payment from your employer is not evidence against being
    // employed — but counting it would drag the typical figure up.
    const rows = [
      ...payroll(['2026-03', '2026-04', '2026-05']),
      credit('2026-06-28', 'ACME CORP', 85000),
      credit('2026-06-18', 'ACME CORP', 200000), // bonus, same payer, same month
      ...payroll(['2026-07', '2026-08']),
    ];

    const salary = detectSalary(rows, { month: '2026-08' });
    expect(salary?.monthlyAmount).toBe(85000);
    expect(salary?.months.map((m) => m.month)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-07',
      '2026-08',
    ]);
  });

  it('picks the larger of two regular incomes', () => {
    const rows = [
      ...payroll(['2026-04', '2026-05', '2026-06']),
      ...['2026-04', '2026-05', '2026-06'].map((m) => credit(`${m}-05`, 'SIDE GIG', 20000)),
    ];
    expect(detectSalary(rows, { month: '2026-06' })?.payer).toBe('ACME CORP');
  });

  it('reports the salary as still arriving in a bonus month', () => {
    const rows = [
      ...payroll(['2026-03', '2026-04', '2026-05']),
      credit('2026-06-28', 'ACME CORP', 85000),
      credit('2026-06-18', 'ACME CORP', 200000),
    ];
    // June is not one of the months that set the figure, but they were paid.
    const salary = detectSalary(rows, { month: '2026-06' });
    expect(salary?.presentInMonth).toBe(true);
    expect(salary?.lastPaidMonth).toBe('2026-06');
  });
});

describe('it does not fire where it should not', () => {
  it('does not call irregular freelance income a salary', () => {
    // The false positive the brief names. Irregular in both timing and size,
    // which is what invoicing looks like.
    const rows = [
      credit('2026-03-07', 'RAZORPAY', 41200),
      credit('2026-04-22', 'RAZORPAY', 9800),
      credit('2026-04-27', 'RAZORPAY', 23100),
      credit('2026-06-11', 'RAZORPAY', 38400),
      credit('2026-07-19', 'RAZORPAY', 12750),
    ];
    expect(detectSalary(rows, { month: '2026-07' })).toBeNull();
  });

  it('refuses two months, however identical', () => {
    expect(detectSalary(payroll(['2026-05', '2026-06']), { month: '2026-06' })).toBeNull();
  });

  it('refuses a gap in the run', () => {
    // Paid in April, May and July is not a salary; it is work that came in.
    expect(
      detectSalary(payroll(['2026-04', '2026-05', '2026-07']), { month: '2026-07' }),
    ).toBeNull();
  });

  it('refuses a payer whose pay day wanders', () => {
    const rows = [
      credit('2026-04-03', 'ACME CORP', 85000),
      credit('2026-05-17', 'ACME CORP', 85000),
      credit('2026-06-26', 'ACME CORP', 85000),
    ];
    expect(detectSalary(rows, { month: '2026-06' })).toBeNull();
  });

  it('refuses amounts that drift past the band', () => {
    const rows = [
      credit('2026-04-28', 'ACME CORP', 85000),
      credit('2026-05-28', 'ACME CORP', 62000),
      credit('2026-06-28', 'ACME CORP', 110000),
    ];
    expect(detectSalary(rows, { month: '2026-06' })).toBeNull();
  });

  it('refuses a regular credit too small to be a wage', () => {
    // ₹6,000 every month on the 1st is a rent share or a standing transfer.
    expect(
      detectSalary(
        ['2026-04', '2026-05', '2026-06'].map((m) => credit(`${m}-01`, 'MUM', 6000)),
        { month: '2026-06' },
      ),
    ).toBeNull();
  });

  it('ignores debits entirely, however regular', () => {
    const rent = ['2026-04', '2026-05', '2026-06'].map((m) =>
      debit(`${m}-01`, 'PRESTIGE PROPERTY MGMT', 32000, 'HOUSING'),
    );
    expect(detectSalary(rent, { month: '2026-06' })).toBeNull();
  });
});

describe('savings rate', () => {
  it('is income minus expense over income', () => {
    const rows = [
      credit('2026-06-28', 'ACME CORP', 100000),
      debit('2026-06-02', 'RENT', 40000, 'HOUSING'),
      debit('2026-06-09', 'BIGBASKET', 10000, 'GROCERIES'),
    ];
    expect(savingsRate(rows, '2026-06')).toMatchObject({
      income: 100000,
      expense: 50000,
      saved: 50000,
      rate: 0.5,
    });
  });

  it('leaves transfers out of both sides', () => {
    // Paying a credit card is neither income nor spending. Counting it would
    // make the rate swing on the month somebody paid their card off early.
    const rows = [
      credit('2026-06-28', 'ACME CORP', 100000),
      debit('2026-06-02', 'RENT', 40000, 'HOUSING'),
      debit('2026-06-22', 'HDFC CARD PAYMENT', 30000, 'TRANSFER'),
      credit('2026-06-22', 'HDFC CARD PAYMENT', 30000),
    ];
    const rate = savingsRate(
      rows.map((r) =>
        r.normalizedMerchant === 'HDFC CARD PAYMENT' ? { ...r, category: 'TRANSFER' as const } : r,
      ),
      '2026-06',
    );
    expect(rate).toMatchObject({ income: 100000, expense: 40000, rate: 0.6 });
  });

  it('nets a refund against spending rather than counting it as income', () => {
    // A returned ₹5,000 pair of shoes is spending that came back. Counting it
    // as income would flatter the rate twice over.
    const rows: IndiaTransaction[] = [
      credit('2026-06-28', 'ACME CORP', 100000),
      debit('2026-06-02', 'MYNTRA', 5000, 'SHOPPING'),
      {
        id: 'r1',
        date: '2026-06-12',
        amount: -5000,
        category: 'REFUND',
        normalizedMerchant: 'MYNTRA',
      },
    ];
    expect(savingsRate(rows, '2026-06')).toMatchObject({
      income: 100000,
      expense: 0,
      rate: 1,
    });
  });

  it('goes negative when more went out than came in', () => {
    const rows = [
      credit('2026-06-28', 'ACME CORP', 50000),
      debit('2026-06-02', 'CROMA', 80000, 'SHOPPING'),
    ];
    expect(savingsRate(rows, '2026-06')).toMatchObject({ saved: -30000, rate: -0.6 });
  });

  it('has no rate at all in a month with no income', () => {
    // Not zero percent. A month with no income does not have a savings rate.
    const rate = savingsRate([debit('2026-06-02', 'CROMA', 8000)], '2026-06');
    expect(rate.rate).toBeNull();
    expect(rate.income).toBe(0);
  });
});
