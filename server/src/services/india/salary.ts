/**
 * Salary detection and the savings rate.
 *
 * The question is "which of these credits is the paycheque", and the answer has
 * to survive two things that break naive approaches:
 *
 *   * **Semi-monthly payroll.** Plenty of Indian employers pay twice a month.
 *     Looking for a single credit on a monthly cadence misses those entirely,
 *     so the unit of comparison here is *what one payer paid in one month*,
 *     not one transaction. A monthly payroll and a semi-monthly one both come
 *     out as a stable monthly total from a stable payer.
 *   * **Bonuses and arrears.** A thirteenth-month bonus lands from the same
 *     payer and blows that month's total well past the tolerance. So a month
 *     outside tolerance does not *disqualify* a payer — it simply is not one of
 *     the months that counts towards the run. Otherwise one bonus in March
 *     would mean the app cannot find your salary for the rest of the year.
 *
 * What it must *not* do is call irregular freelance income a salary. Three
 * independent gates stand in the way: the months must be consecutive, the
 * monthly totals must agree within a tight band, and the pay day must land in
 * roughly the same part of the month each time. Irregular invoicing fails all
 * three, and the tests assert that against the seeded freelance pattern.
 */
import { median } from '../anomalies/statistics';
import {
  dayOf,
  dayOfMonthDistance,
  monthOf,
  round2,
  trailingMonths,
  type IndiaTransaction,
} from './types';

export interface SalaryThresholds {
  /** Months of history considered, including the month being analysed. */
  lookbackMonths: number;
  /** Consecutive qualifying months needed before "salary" is a claim worth making. */
  minMonths: number;
  /** How far a month's total may sit from the median and still count. ±10%. */
  amountTolerance: number;
  /** How far the pay day may drift, in days, and still be "the same day". */
  dayTolerance: number;
  /** Below this a credit is not a salary however regular it is. */
  minMonthlyAmount: number;
}

export const SALARY_DEFAULTS: SalaryThresholds = {
  lookbackMonths: 6,
  /**
   * Three, not two. Two months of similar credits from one payer is a pattern
   * you can get by coincidence — two invoices to the same client, a deposit and
   * its reversal. Three consecutive months is where "this is their income"
   * stops being a guess.
   */
  minMonths: 3,
  /** The brief's ~10%. Wide enough for overtime and a benefit change. */
  amountTolerance: 0.1,
  /**
   * Pay days move: a payday on a Sunday is paid on the Friday, and a month with
   * 31 days shifts an end-of-month run. Five days absorbs that without
   * admitting an invoice paid whenever the client got round to it.
   */
  dayTolerance: 5,
  /**
   * ₹10,000 a month. Below this a regular credit is far more likely to be a
   * standing transfer from family or a rent share than employment income, and
   * a wrong salary figure makes the savings rate wrong too.
   */
  minMonthlyAmount: 10000,
};

export interface SalaryMonth {
  month: string;
  /** Total credited by this payer that month, as a positive magnitude. */
  amount: number;
  /** Day of month of the first credit from this payer that month. */
  day: number;
  /** How many credits made up the total — 1 for monthly payroll, 2 for semi-monthly. */
  credits: number;
}

export interface DetectedSalary {
  /** The payer reference, as normalized. */
  payer: string;
  /** The typical monthly figure: the median of the qualifying months. */
  monthlyAmount: number;
  /** The typical pay day, for a reader who wants to recognise it. */
  payDay: number;
  /** Credits per month in the qualifying run: 1 monthly, 2 semi-monthly. */
  creditsPerMonth: number;
  /** The months that agreed, oldest first. Any bonus month is skipped. */
  months: SalaryMonth[];
  /**
   * Whether this payer credited anything in the month being analysed.
   *
   * A fact about the payer, not about the run: a bonus month does not count
   * towards the typical figure, but the salary still arrived, and saying
   * otherwise would read as "you were not paid this month".
   */
  presentInMonth: boolean;
  /** The most recent month this payer credited anything at all. */
  lastPaidMonth: string;
}

/** One payer's month-by-month picture, before any judgement is made. */
function monthlyTotalsByPayer(
  transactions: IndiaTransaction[],
  window: Set<string>,
): Map<string, Map<string, SalaryMonth>> {
  const byPayer = new Map<string, Map<string, SalaryMonth>>();

  for (const t of transactions) {
    // Credits only, and only from something that named a payer. An unnamed
    // credit cannot be matched to the same payer next month, which is the whole
    // basis of the claim.
    if (t.amount >= 0 || !t.normalizedMerchant) continue;
    const month = monthOf(t.date);
    if (!window.has(month)) continue;

    const months = byPayer.get(t.normalizedMerchant) ?? new Map<string, SalaryMonth>();
    const existing = months.get(month);
    if (existing) {
      existing.amount = round2(existing.amount + Math.abs(t.amount));
      existing.credits += 1;
      // The *first* credit of the month is the anchor. With semi-monthly pay
      // the larger of the two alternates at random, so anchoring on the biggest
      // would make the pay day look unstable when it is not.
      if (dayOf(t.date) < existing.day) existing.day = dayOf(t.date);
    } else {
      months.set(month, {
        month,
        amount: round2(Math.abs(t.amount)),
        day: dayOf(t.date),
        credits: 1,
      });
    }
    byPayer.set(t.normalizedMerchant, months);
  }

  return byPayer;
}

/**
 * The longest run of consecutive months whose totals and pay days agree.
 *
 * Consecutive matters. Income that shows up in four months out of six is not a
 * salary, it is work that came in when it came in — and a run with a hole in it
 * is exactly what that looks like.
 */
function qualifyingRun(months: SalaryMonth[], config: SalaryThresholds): SalaryMonth[] {
  const ordered = [...months].sort((a, b) => (a.month < b.month ? -1 : 1));
  const reference = median(ordered.map((m) => m.amount));
  if (reference < config.minMonthlyAmount) return [];

  const agrees = (m: SalaryMonth) =>
    Math.abs(m.amount - reference) / reference <= config.amountTolerance;

  let best: SalaryMonth[] = [];
  let run: SalaryMonth[] = [];
  /** The last month *seen*, which advances even over a month that is skipped. */
  let previousMonth: string | null = null;
  /**
   * The last month *counted*, which the pay day and credit count are judged
   * against. Kept apart from `previousMonth` because a bonus paid mid-month
   * moves that month's first credit — and comparing July's pay day against a
   * bonus date rather than against June's pay day would break a run that
   * never actually broke.
   */
  let anchor: SalaryMonth | null = null;

  const close = () => {
    // `>=` so equal-length runs resolve to the most recent: a salary that ended
    // in the spring says nothing about this month.
    if (run.length >= best.length) best = run;
  };

  for (const month of ordered) {
    const consecutive = previousMonth === null || isNextMonth(previousMonth, month.month);
    const sameDay =
      anchor === null || dayOfMonthDistance(anchor.day, month.day) <= config.dayTolerance;
    const sameShape = anchor === null || anchor.credits === month.credits;

    if (agrees(month) && consecutive && sameDay && sameShape) {
      run.push(month);
      anchor = month;
    } else if (consecutive && run.length > 0 && month.amount > reference) {
      // A month *above* the band from the same payer is a bonus or arrears, and
      // an extra payment from your employer is not evidence against being
      // employed. Skipped rather than counted — counting it would drag the
      // typical figure up — but the chain survives, so one bonus in July does
      // not stop the app finding the salary after it. The anchor deliberately
      // does not move: the bonus is not the pay day.
    } else {
      // A gap, a short month, a moved pay day: the pattern really did break.
      close();
      run = agrees(month) ? [month] : [];
      anchor = run.length > 0 ? month : null;
    }

    previousMonth = month.month;
  }
  close();

  return best.length >= config.minMonths ? best : [];
}

const isNextMonth = (a: string, b: string): boolean => {
  const [ay, am] = a.split('-').map(Number);
  return b === new Date(Date.UTC(ay, am, 1)).toISOString().slice(0, 7);
};

export type SalaryOptions = Partial<SalaryThresholds> & { month: string };

/**
 * The largest regular monthly credit that behaves like employment income.
 *
 * Returns `null` rather than a best guess when nothing qualifies. "We could not
 * find your salary" is a usable answer; a savings rate computed against a
 * number that is not income is not.
 */
export function detectSalary(
  transactions: IndiaTransaction[],
  options: SalaryOptions,
): DetectedSalary | null {
  const config = { ...SALARY_DEFAULTS, ...options };
  const window = new Set(trailingMonths(config.month, config.lookbackMonths));

  const candidates: DetectedSalary[] = [];

  monthlyTotalsByPayer(transactions, window).forEach((months, payer) => {
    const run = qualifyingRun([...months.values()], config);
    if (run.length === 0) return;

    candidates.push({
      payer,
      monthlyAmount: round2(median(run.map((m) => m.amount))),
      payDay: Math.round(median(run.map((m) => m.day))),
      creditsPerMonth: run[0].credits,
      months: run,
      presentInMonth: months.has(config.month),
      lastPaidMonth: [...months.keys()].sort().slice(-1)[0],
    });
  });

  if (candidates.length === 0) return null;

  // "The largest recurring monthly credit" — where two payers both qualify, the
  // bigger one is the salary and the other is a side income.
  candidates.sort((a, b) => b.monthlyAmount - a.monthlyAmount || (a.payer < b.payer ? -1 : 1));
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Savings rate
// ---------------------------------------------------------------------------

export interface SavingsRate {
  month: string;
  /** All credits that month except transfers and refunds, as a magnitude. */
  income: number;
  /** All debits that month except transfers, as a magnitude. */
  expense: number;
  /** `income - expense`. Positive means they kept something. */
  saved: number;
  /** `saved / income`, or null when there was no income to divide by. */
  rate: number | null;
}

/**
 * What share of the month's income was not spent.
 *
 * Transfers are excluded from both sides (PROJECT_CONTEXT.md §5): moving money
 * to a credit card is neither income nor spending, and counting it would make
 * the rate swing wildly on a month somebody paid their card off early.
 *
 * A refund is not income either — it is spending that came back — so it nets
 * against expense rather than inflating the denominator. Counting a returned
 * ₹4,599 pair of shoes as income would flatter the rate twice over.
 *
 * The rate is `null`, never `0`, when there is no income. A month with no
 * income does not have a savings rate of zero percent; it does not have one.
 */
export function savingsRate(transactions: IndiaTransaction[], month: string): SavingsRate {
  let income = 0;
  let expense = 0;

  for (const t of transactions) {
    if (monthOf(t.date) !== month) continue;
    if (t.category === 'TRANSFER') continue;

    if (t.category === 'REFUND') {
      // Money back on something bought: reduces what was spent.
      expense += t.amount;
      continue;
    }
    if (t.amount < 0) income += Math.abs(t.amount);
    else expense += t.amount;
  }

  income = round2(income);
  expense = round2(expense);
  const saved = round2(income - expense);

  return {
    month,
    income,
    expense,
    saved,
    rate: income > 0 ? Math.round((saved / income) * 1000) / 1000 : null,
  };
}
