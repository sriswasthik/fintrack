/**
 * All five Phase 19 features against the real seed dataset.
 *
 * The per-detector suites work on small hand-built fixtures, which is where the
 * thresholds are pinned. This one asks a different question: do they fire on
 * the dataset the app actually ships — six months of noisy spending with
 * refunds, transfers, duplicates, a bonus and irregular freelance income in it
 * — and do they stay quiet about the things in that data designed to look like
 * a finding without being one.
 */
import { describe, expect, it } from 'vitest';

import { generateDataset, transactionsByEdgeCase } from '../../../prisma/seed-data';
import { buildIndiaInsights } from './index';
import type { IndiaTransaction } from './types';

const dataset = generateDataset();

/** The dataset as the detectors see it, using the generator's ground truth. */
const rows: IndiaTransaction[] = dataset.map((t) => ({
  id: String(t.row),
  date: t.date,
  amount: t.amount,
  category: t.manualCategory ?? t.expectedCategory,
  normalizedMerchant: t.normalizedMerchant,
  description: t.description,
}));

const byEdgeCase = transactionsByEdgeCase(dataset);

/** August: the last month of the window that is a whole month. */
const august = buildIndiaInsights(rows, { month: '2026-08' });
/** September: a partial month, and the only one overlapping a festive window. */
const september = buildIndiaInsights(rows, { month: '2026-09' });

describe('the fixture carries what the phase needs', () => {
  it('has a salary, an EMI, its decoy, two SIPs and a festive bump', () => {
    expect(byEdgeCase.get('variable-income')?.length).toBeGreaterThan(10);
    expect(byEdgeCase.get('emi')).toHaveLength(7);
    expect(byEdgeCase.get('emi-decoy')).toHaveLength(2);
    expect(byEdgeCase.get('sip')).toHaveLength(13);
    expect(byEdgeCase.get('festive')).toHaveLength(5);
  });
});

describe('1. salary and savings rate', () => {
  it('finds the semi-monthly payroll and its monthly worth', () => {
    expect(august.salary).toMatchObject({
      payer: 'INFOSYS LTD',
      payDay: 15,
      // Paid on the 15th and the 30th: two credits, one salary.
      creditsPerMonth: 2,
      presentInMonth: true,
    });
    expect(august.salary?.monthlyAmount).toBeGreaterThan(115000);
    expect(august.salary?.monthlyAmount).toBeLessThan(125000);
  });

  it('is not derailed by the bonus month planted in the fixture', () => {
    // July carries a ₹75,000 bonus from the same payer. It is skipped, not
    // counted, and it does not break the chain either side of it.
    const months = august.salary?.months.map((m) => m.month);
    expect(months).toContain('2026-06');
    expect(months).toContain('2026-08');
    expect(months).not.toContain('2026-07');
  });

  it('does not mistake the irregular freelance income for a salary', () => {
    // RAZORPAY pays 0-2 times a month at ₹8,000-45,000. It is in the data
    // precisely so that something has to reject it.
    const razorpay = rows.filter((r) => r.normalizedMerchant === 'RAZORPAY');
    expect(razorpay.length).toBeGreaterThan(3);
    expect(august.salary?.payer).not.toBe('RAZORPAY');
  });

  it('computes a savings rate from the month it was asked about', () => {
    expect(august.savings).toMatchObject({ month: '2026-08' });
    expect(august.savings.income).toBeGreaterThan(0);
    expect(august.savings.rate).not.toBeNull();
    // income - expense, to the paisa.
    expect(august.savings.saved).toBe(
      Math.round((august.savings.income - august.savings.expense) * 100) / 100,
    );
  });

  it('has no rate for a month whose income has not landed yet', () => {
    // The window stops on 7 September and payday is the 15th. No income is not
    // a savings rate of zero.
    expect(september.savings.income).toBe(0);
    expect(september.savings.rate).toBeNull();
  });
});

describe('2. EMI tracker', () => {
  it('finds the planted instalment', () => {
    expect(august.loans.loans).toHaveLength(1);
    expect(august.loans.loans[0]).toMatchObject({
      merchant: 'BAJAJ FINANCE EMI',
      monthlyAmount: 18450,
      debitDay: 5,
      firstSeen: '2026-03-05',
      active: true,
      nextInstalment: '2026-09-05',
    });
  });

  it('does not pick up the two similar one-off repayments', () => {
    // MUTHOOT FINANCE: ₹18,500 in March and ₹18,300 in June. Similar money to
    // a lender, twice, months apart — the false positive the brief names.
    const muthoot = rows.filter((r) => r.normalizedMerchant === 'MUTHOOT FINANCE');
    expect(muthoot).toHaveLength(2);
    expect(august.loans.loans.map((l) => l.merchant)).not.toContain('MUTHOOT FINANCE');
  });

  it('labels its remaining-tenure guess as a guess', () => {
    const estimate = august.loans.loans[0].estimate;
    expect(estimate).not.toBeNull();
    expect(estimate?.remainingMonths).toBeGreaterThan(0);
    expect(estimate?.caveat).toMatch(/^Estimate only\./);
  });

  it('states the share of income it takes', () => {
    expect(august.loans.totalMonthly).toBe(18450);
    expect(august.loans.shareOfIncome).toBeCloseTo(18450 / august.salary!.monthlyAmount, 3);
  });
});

describe('3. SIP tracker', () => {
  it('finds both planted plans and adds them up', () => {
    expect(august.investments.plans.map((p) => p.merchant)).toEqual([
      'ZERODHA COIN SIP',
      'AXIS MUTUAL FUND SIP',
    ]);
    expect(august.investments.totalMonthly).toBe(7500);
  });

  it('states what share of income they take', () => {
    expect(august.investments.shareOfIncome).toBeCloseTo(7500 / august.salary!.monthlyAmount, 3);
  });

  it('does not mistake the monthly subscriptions for investments', () => {
    // NETFLIX, SPOTIFY and the rest are the same shape — fixed amount, fixed
    // day, every month — and are kept out by their category alone.
    const merchants = august.investments.plans.map((p) => p.merchant);
    expect(merchants).not.toContain('NETFLIX');
    expect(merchants).not.toContain('SPOTIFY');
    expect(merchants).not.toContain('BAJAJ FINANCE EMI');
  });
});

describe('4. upcoming bills', () => {
  it('predicts next month from the seeded subscriptions and utilities', () => {
    const bills = august.upcoming.bills;
    expect(bills.length).toBeGreaterThan(3);
    expect(bills.map((b) => b.merchant)).toContain('JIO FIBER');
    expect(bills.map((b) => b.merchant)).toContain('NETFLIX');
  });

  it('projects onto the day of the month the bill actually lands on', () => {
    // JIO FIBER bills on the 5th. Averaging 30- and 31-day gaps would drift it
    // to the 6th, then the 7th, and so on.
    const jio = august.upcoming.bills.find((b) => b.merchant === 'JIO FIBER');
    expect(jio).toMatchObject({ expectedDay: 5, expectedDate: '2026-09-05', confidence: 'high' });
  });

  it('stays inside utilities and subscriptions', () => {
    august.upcoming.bills.forEach((b) =>
      expect(['UTILITIES', 'SUBSCRIPTIONS']).toContain(b.category),
    );
  });

  it('does not predict a date for the everyday merchants', () => {
    // The coffee shop and the grocer are billed many times a month, which is
    // the gate Phase 6 already carries.
    const merchants = august.upcoming.bills.map((b) => b.merchant);
    expect(merchants).not.toContain('THIRD WAVE COFFEE');
    expect(merchants).not.toContain('BIGBASKET');
    expect(merchants).not.toContain('SWIGGY');
  });
});

describe('5. festive-season note', () => {
  it('fires for the one month in this window that overlaps a festive one', () => {
    expect(september.festive).not.toBeNull();
    expect(september.festive?.windows.map((w) => w.key)).toEqual(['dussehra-diwali']);
  });

  it('names the categories that moved and no others', () => {
    // The fixture bumps shopping and gifts and leaves dining alone, so the note
    // has to leave dining alone too.
    expect(september.festive?.categories.map((c) => c.category)).toEqual([
      'SHOPPING',
      'GIFTS_DONATIONS',
    ]);
  });

  it("compares each category to the user's own trailing median", () => {
    const shopping = september.festive?.categories.find((c) => c.category === 'SHOPPING');
    expect(shopping?.baseline).toBeGreaterThan(0);
    expect(shopping?.amount).toBeGreaterThan(shopping!.baseline);
    expect(shopping?.difference).toBe(
      Math.round((shopping!.amount - shopping!.baseline) * 100) / 100,
    );
  });

  it('says nothing about an ordinary month', () => {
    // August overlaps no festive window at all, whatever was spent in it.
    expect(august.festive).toBeNull();
  });

  it('reads as an observation, not a verdict', () => {
    expect(september.festive?.note).not.toMatch(
      /overspen|too much|excessive|should|unusually|!|\bbecause\b|\bdue to\b/i,
    );
  });
});
