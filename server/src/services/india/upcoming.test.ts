import { describe, expect, it } from 'vitest';

import { predictUpcomingBills, totalUpcoming } from './upcoming';
import type { IndiaTransaction } from './types';

let counter = 0;
const debit = (
  date: string,
  merchant: string,
  amount: number,
  category: IndiaTransaction['category'] = 'SUBSCRIPTIONS',
): IndiaTransaction => ({
  id: `u${++counter}`,
  date,
  amount,
  category,
  normalizedMerchant: merchant,
});

/** A bill on the same date every month. */
const bill = (
  months: string[],
  day: number,
  amount: number,
  merchant: string,
  category: IndiaTransaction['category'] = 'SUBSCRIPTIONS',
) => months.map((m) => debit(`${m}-${String(day).padStart(2, '0')}`, merchant, amount, category));

const MONTHS = ['2026-04', '2026-05', '2026-06'];
const asOf = { month: '2026-06', asOf: '2026-06-20' };

describe('it fires on a real recurring bill', () => {
  it('projects the next charge from the observed cadence', () => {
    const [next] = predictUpcomingBills(bill(MONTHS, 17, 649, 'NETFLIX'), asOf);

    expect(next).toMatchObject({
      merchant: 'NETFLIX',
      expectedDate: '2026-07-17',
      expectedAmount: 649,
      lastCharged: '2026-06-17',
      confidence: 'high',
      observations: 3,
    });
  });

  it('predicts a utility bill as readily as a subscription', () => {
    const rows = bill(MONTHS, 5, 899, 'JIO FIBER', 'UTILITIES');
    expect(predictUpcomingBills(rows, asOf)[0]).toMatchObject({
      merchant: 'JIO FIBER',
      category: 'UTILITIES',
      expectedDate: '2026-07-05',
    });
  });

  it('drops to medium confidence when the billing date wanders a little', () => {
    const rows = [
      debit('2026-04-03', 'BESCOM', 1400, 'UTILITIES'),
      debit('2026-05-06', 'BESCOM', 1400, 'UTILITIES'),
      debit('2026-06-08', 'BESCOM', 1400, 'UTILITIES'),
    ];
    expect(predictUpcomingBills(rows, asOf)[0]?.confidence).toBe('medium');
  });

  it('orders by when the money leaves, and totals what is expected', () => {
    const rows = [
      ...bill(MONTHS, 17, 649, 'NETFLIX'),
      ...bill(MONTHS, 6, 75, 'APPLE ICLOUD'),
      ...bill(MONTHS, 27, 699, 'ADOBE'),
    ];
    const upcoming = predictUpcomingBills(rows, asOf);

    // Apple on the 6th and Netflix on the 17th are next month's; Adobe was
    // last charged on the 27th, which is after `asOf`, so its next one is the
    // furthest away.
    expect(upcoming.map((b) => b.merchant)).toEqual(['APPLE ICLOUD', 'NETFLIX', 'ADOBE']);
    expect(totalUpcoming(upcoming)).toBe(1423);
  });
});

describe('it does not fire where it should not', () => {
  it('says nothing about a merchant billed several times a month', () => {
    // Phase 6's strongest gate, inherited: you are billed by Netflix once a
    // month and you buy coffee eight times.
    const coffee = [1, 9, 18, 26].flatMap((day) =>
      MONTHS.map((m) =>
        debit(`${m}-${String(day).padStart(2, '0')}`, 'THIRD WAVE COFFEE', 240, 'DINING'),
      ),
    );
    expect(predictUpcomingBills(coffee, asOf)).toEqual([]);
  });

  it('will not name a date for a bill whose date is not predictable', () => {
    // Monthly — every gap is inside Phase 6's 24-38 day band — but the day it
    // lands on walks from the 1st to the 20th. There is no date worth naming,
    // and saying nothing beats inventing one.
    const rows = [
      debit('2026-03-01', 'SOME BILL', 500, 'UTILITIES'),
      debit('2026-04-08', 'SOME BILL', 500, 'UTILITIES'),
      debit('2026-05-16', 'SOME BILL', 500, 'UTILITIES'),
      debit('2026-06-20', 'SOME BILL', 500, 'UTILITIES'),
    ];
    expect(predictUpcomingBills(rows, asOf)).toEqual([]);
  });

  it('stays out of categories where a due date would be absurd', () => {
    // Groceries on a monthly cadence is a statistical fact and a useless
    // prediction.
    const rows = bill(MONTHS, 8, 4200, 'BIGBASKET', 'GROCERIES');
    expect(predictUpcomingBills(rows, asOf)).toEqual([]);
  });

  it('drops a prediction that has already come and gone', () => {
    // The feature answers "what is coming". A charge that has not appeared is
    // not something a statement can confirm — it may have been paid elsewhere.
    const rows = bill(MONTHS, 5, 899, 'JIO FIBER', 'UTILITIES');
    expect(predictUpcomingBills(rows, { month: '2026-06', asOf: '2026-07-20' })).toEqual([]);
  });

  it('will not look past its horizon', () => {
    const rows = bill(MONTHS, 17, 649, 'NETFLIX');
    // Asked from the start of June, July's charge is 45 days out at most; asked
    // with a two-week horizon it is beyond the edge.
    expect(predictUpcomingBills(rows, { ...asOf, horizonDays: 14 })).toEqual([]);
  });

  it('says nothing from a single charge', () => {
    expect(predictUpcomingBills([debit('2026-06-17', 'NETFLIX', 649)], asOf)).toEqual([]);
  });
});
