import { describe, expect, it } from 'vitest';

import {
  detectEmis,
  estimateRemaining,
  EMI_DEFAULTS,
  looksLikeEmi,
  nextInstalmentDate,
} from './emi';
import type { IndiaTransaction } from './types';

let counter = 0;
const debit = (
  date: string,
  merchant: string,
  amount: number,
  category: IndiaTransaction['category'] = 'EMI_LOAN',
  description?: string,
): IndiaTransaction => ({
  id: `t${++counter}`,
  date,
  amount,
  category,
  normalizedMerchant: merchant,
  ...(description ? { description } : {}),
});

/** A clean instalment plan: same rupee, same day, consecutive months. */
const plan = (months: string[], day = 5, amount = 18450, merchant = 'BAJAJ FINANCE EMI') =>
  months.map((m) => debit(`${m}-${String(day).padStart(2, '0')}`, merchant, amount));

const MONTHS = ['2026-04', '2026-05', '2026-06'];

describe('it fires on a real EMI', () => {
  it('finds a fixed monthly instalment', () => {
    const [emi] = detectEmis(plan(MONTHS), { month: '2026-06' });

    expect(emi).toMatchObject({
      merchant: 'BAJAJ FINANCE EMI',
      monthlyAmount: 18450,
      debitDay: 5,
      firstSeen: '2026-04-05',
      lastSeen: '2026-06-05',
      instalmentsObserved: 3,
      active: true,
    });
  });

  it('finds one by narration when the category has not caught up', () => {
    // A row the rule engine has not categorized yet is still recognisably an
    // instalment; the narration is where EMI lives on a bank statement.
    const rows = MONTHS.map((m) =>
      debit(`${m}-11`, 'ICICI BANK', 9900, 'UNCATEGORIZED', 'ACH D- ICICI BANK LOAN EMI 88213'),
    );
    expect(detectEmis(rows, { month: '2026-06' })).toHaveLength(1);
  });

  it('absorbs a mandate landing a day or two either side', () => {
    const rows = [
      debit('2026-04-05', 'BAJAJ FINANCE EMI', 18450),
      debit('2026-05-04', 'BAJAJ FINANCE EMI', 18450),
      debit('2026-06-07', 'BAJAJ FINANCE EMI', 18450),
    ];
    expect(detectEmis(rows, { month: '2026-06' })).toHaveLength(1);
  });

  it('sorts the biggest commitment first', () => {
    const rows = [...plan(MONTHS), ...plan(MONTHS, 18, 2499, 'ONE CARD EMI')];
    expect(detectEmis(rows, { month: '2026-06' }).map((e) => e.monthlyAmount)).toEqual([
      18450, 2499,
    ]);
  });

  it('says where the next instalment falls', () => {
    const [emi] = detectEmis(plan(MONTHS), { month: '2026-06' });
    expect(nextInstalmentDate(emi)).toBe('2026-07-05');
  });

  it('marks a plan that stopped months ago as finished, with no estimate', () => {
    const [emi] = detectEmis(plan(['2026-01', '2026-02', '2026-03']), { month: '2026-06' });
    expect(emi.active).toBe(false);
    expect(emi.estimate).toBeNull();
    expect(nextInstalmentDate(emi)).toBeNull();
  });
});

describe('it does not fire where it should not', () => {
  it('does not call two unrelated transfers of a similar amount a loan', () => {
    // The false positive the brief names. Similar money to the same lender, but
    // months apart and only twice — which is a coincidence, not a contract.
    const rows = [
      debit('2026-03-19', 'MUTHOOT FINANCE', 18500),
      debit('2026-06-23', 'MUTHOOT FINANCE', 18300),
    ];
    expect(detectEmis(rows, { month: '2026-06' })).toEqual([]);
  });

  it('refuses two instalments even when they are perfect', () => {
    expect(detectEmis(plan(['2026-05', '2026-06']), { month: '2026-06' })).toEqual([]);
  });

  it('refuses an amount that drifts more than 2%', () => {
    // A bill drifts; an instalment does not. This is the gate that keeps
    // ordinary recurring spending out of the loan list.
    const rows = [
      debit('2026-04-05', 'SOME LENDER', 18450),
      debit('2026-05-05', 'SOME LENDER', 19800),
      debit('2026-06-05', 'SOME LENDER', 17600),
    ];
    expect(detectEmis(rows, { month: '2026-06' })).toEqual([]);
  });

  it('refuses a gap in the months', () => {
    expect(detectEmis(plan(['2026-03', '2026-04', '2026-06']), { month: '2026-06' })).toEqual([]);
  });

  it('refuses a debit day that wanders', () => {
    const rows = [
      debit('2026-04-02', 'SOME LENDER', 18450),
      debit('2026-05-16', 'SOME LENDER', 18450),
      debit('2026-06-27', 'SOME LENDER', 18450),
    ];
    expect(detectEmis(rows, { month: '2026-06' })).toEqual([]);
  });

  it('refuses a lender billed twice in one month', () => {
    // A prepayment or a second product, not one instalment plan.
    const rows = [...plan(MONTHS), debit('2026-05-20', 'BAJAJ FINANCE EMI', 18450)];
    expect(detectEmis(rows, { month: '2026-06' })).toEqual([]);
  });

  it('refuses a standing debit too small to be a loan', () => {
    expect(detectEmis(plan(MONTHS, 5, 400, 'TINY'), { month: '2026-06' })).toEqual([]);
  });

  it('ignores a credit, however regular', () => {
    const rows = MONTHS.map((m) => debit(`${m}-05`, 'BAJAJ FINANCE EMI', -18450));
    expect(detectEmis(rows, { month: '2026-06' })).toEqual([]);
  });

  it('ignores a monthly bill that is neither categorized nor worded as a loan', () => {
    const rent = MONTHS.map((m) => debit(`${m}-01`, 'PRESTIGE PROPERTY MGMT', 32000, 'HOUSING'));
    expect(detectEmis(rent, { month: '2026-06' })).toEqual([]);
  });
});

describe('looksLikeEmi', () => {
  it('accepts the category or an EMI-shaped narration, and nothing else', () => {
    expect(looksLikeEmi(debit('2026-06-05', 'X', 100, 'EMI_LOAN'))).toBe(true);
    expect(
      looksLikeEmi(debit('2026-06-05', 'X', 100, 'UNCATEGORIZED', 'ACH D- HDFC LOAN EMI')),
    ).toBe(true);
    expect(looksLikeEmi(debit('2026-06-05', 'X', 100, 'UNCATEGORIZED', 'NACH DEBIT 8821'))).toBe(
      true,
    );
    expect(looksLikeEmi(debit('2026-06-05', 'SWIGGY', 100, 'DINING', 'SWIGGY ORDER'))).toBe(false);
  });
});

describe('the remaining-tenure estimate', () => {
  it('snaps to the next standard tenure and carries its caveat', () => {
    const estimate = estimateRemaining(7, '2026-09', EMI_DEFAULTS);

    expect(estimate).toMatchObject({
      assumedTenureMonths: 9,
      remainingMonths: 2,
      projectedFinalMonth: '2026-11',
    });
    // Never presented as a fact. The statement cannot see when the loan began
    // or how long it runs, and the wording has to say so.
    expect(estimate?.caveat).toMatch(/^Estimate only\./);
    expect(estimate?.caveat).toMatch(/loan agreement is the only authority/);
  });

  it('declines to guess past the longest tenure it knows', () => {
    expect(estimateRemaining(600, '2026-09', EMI_DEFAULTS)).toBeNull();
  });

  it('never claims a loan is already finished', () => {
    // Snapping to a tenure equal to what has been paid would read as "0 left",
    // which is a claim, not an estimate.
    for (let paid = 1; paid <= 120; paid++) {
      const estimate = estimateRemaining(paid, '2026-09', EMI_DEFAULTS);
      if (estimate) expect(estimate.remainingMonths).toBeGreaterThan(0);
    }
  });
});
