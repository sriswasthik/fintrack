import { describe, expect, it } from 'vitest';

import { detectSips, summariseSips } from './sip';
import type { IndiaTransaction } from './types';

let counter = 0;
const debit = (
  date: string,
  merchant: string,
  amount: number,
  category: IndiaTransaction['category'] = 'INVESTMENTS',
): IndiaTransaction => ({
  id: `s${++counter}`,
  date,
  amount,
  category,
  normalizedMerchant: merchant,
});

const sip = (months: string[], day = 7, amount = 5000, merchant = 'ZERODHA COIN') =>
  months.map((m) => debit(`${m}-${String(day).padStart(2, '0')}`, merchant, amount));

const MONTHS = ['2026-04', '2026-05', '2026-06'];

describe('it fires on a real SIP', () => {
  it('finds a monthly contribution', () => {
    const [plan] = detectSips(sip(MONTHS), { month: '2026-06' });
    expect(plan).toMatchObject({
      merchant: 'ZERODHA COIN',
      monthlyAmount: 5000,
      debitDay: 7,
      contributionsObserved: 3,
      active: true,
    });
  });

  it('tolerates the rounding a fund house does, which an EMI would not', () => {
    // 5% here against an EMI's 2%: a SIP buys whole units and a step-up SIP
    // raises itself on purpose.
    const rows = [
      debit('2026-04-07', 'AXIS MUTUAL FUND', 2500),
      debit('2026-05-07', 'AXIS MUTUAL FUND', 2560),
      debit('2026-06-07', 'AXIS MUTUAL FUND', 2450),
    ];
    expect(detectSips(rows, { month: '2026-06' })).toHaveLength(1);
  });

  it('adds several plans into one monthly outgo, biggest first', () => {
    const rows = [...sip(MONTHS), ...sip(MONTHS, 12, 2500, 'AXIS MUTUAL FUND')];
    const plans = detectSips(rows, { month: '2026-06' });

    expect(plans.map((p) => p.merchant)).toEqual(['ZERODHA COIN', 'AXIS MUTUAL FUND']);
    expect(summariseSips(plans, 120000)).toMatchObject({
      totalMonthly: 7500,
      shareOfIncome: 0.063,
    });
  });

  it('leaves a stopped plan out of the monthly outgo', () => {
    const rows = [...sip(MONTHS), ...sip(['2025-11', '2025-12', '2026-01'], 20, 9000, 'OLD SIP')];
    const plans = detectSips(rows, { month: '2026-06' });

    expect(plans.find((p) => p.merchant === 'OLD SIP')?.active).toBe(false);
    // Reported, because it is history worth seeing — but not counted as money
    // still leaving every month.
    expect(summariseSips(plans, 120000).totalMonthly).toBe(5000);
  });
});

describe('it does not fire where it should not', () => {
  it('does not call ad-hoc stock buying a plan', () => {
    // Investing, certainly. But there is no monthly figure to report.
    const rows = [
      debit('2026-04-03', 'ZERODHA', 12000),
      debit('2026-04-19', 'ZERODHA', 4500),
      debit('2026-05-28', 'ZERODHA', 31000),
      debit('2026-06-11', 'ZERODHA', 7200),
    ];
    expect(detectSips(rows, { month: '2026-06' })).toEqual([]);
  });

  it('refuses two contributions', () => {
    expect(detectSips(sip(['2026-05', '2026-06']), { month: '2026-06' })).toEqual([]);
  });

  it('refuses a contribution that drifts past 5%', () => {
    const rows = [
      debit('2026-04-07', 'GROWW', 5000),
      debit('2026-05-07', 'GROWW', 6500),
      debit('2026-06-07', 'GROWW', 4100),
    ];
    expect(detectSips(rows, { month: '2026-06' })).toEqual([]);
  });

  it('refuses a gap in the months', () => {
    expect(detectSips(sip(['2026-03', '2026-04', '2026-06']), { month: '2026-06' })).toEqual([]);
  });

  it('ignores a regular debit that is not an investment', () => {
    // Same shape, same rupee, same day — but a Netflix bill is not a SIP, and
    // the category is what says so.
    const netflix = MONTHS.map((m) => debit(`${m}-17`, 'NETFLIX', 649, 'SUBSCRIPTIONS'));
    expect(detectSips(netflix, { month: '2026-06' })).toEqual([]);
  });

  it('ignores a redemption, which is money coming back', () => {
    const rows = MONTHS.map((m) => debit(`${m}-07`, 'ZERODHA COIN', -5000));
    expect(detectSips(rows, { month: '2026-06' })).toEqual([]);
  });
});

describe('share of income', () => {
  it('is null rather than zero when no salary was found', () => {
    // An unknown share shown as 0% reads as "you are investing nothing".
    const plans = detectSips(sip(MONTHS), { month: '2026-06' });
    expect(summariseSips(plans, null).shareOfIncome).toBeNull();
    expect(summariseSips(plans, 0).shareOfIncome).toBeNull();
  });
});
