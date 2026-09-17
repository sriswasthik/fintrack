/**
 * Predicting when a recurring bill will next be charged.
 *
 * Phase 6 already knows which merchants bill on a monthly cadence — that is
 * `findRecurringCharges`, and it carries the hard-won gate that a merchant
 * billing twice in any month is everyday spending rather than a subscription.
 * Re-deriving that here would be a second copy of the rule to keep in step, so
 * this reuses it and does one job on top: say when the next one is due.
 *
 * Every figure here is a **prediction**, and the shape of the data says so.
 * `confidence` is derived from how tightly the observed gaps cluster, and the
 * client is expected to render the word "expected", never a due date stated as
 * fact. A bill that is predicted and does not arrive is a mild annoyance; a
 * bill presented as certain and wrong is a reason not to trust the app.
 */
import { findRecurringCharges, type AnomalyTransaction } from '../anomalies/detect';
import { median } from '../anomalies/statistics';
import {
  addMonths,
  dateInMonth,
  dayOf,
  dayOfMonthDistance,
  daysBetween,
  monthOf,
  round2,
  type IndiaTransaction,
} from './types';

export interface UpcomingThresholds {
  lookbackMonths: number;
  /** Only bills in these categories are predicted. */
  categories: string[];
  /** How far ahead a prediction is offered. */
  horizonDays: number;
  /** A billing day that moves less than this counts as a fixed date. */
  highConfidenceSpreadDays: number;
  /** ...and less than this, a loose one. Beyond it, no prediction is offered. */
  maxSpreadDays: number;
}

export const UPCOMING_DEFAULTS: UpcomingThresholds = {
  lookbackMonths: 6,
  /**
   * Utilities and subscriptions only, which is what the brief asks for. A
   * monthly grocery run is recurring in the statistical sense and predicting a
   * date for it would be both useless and slightly absurd.
   */
  categories: ['UTILITIES', 'SUBSCRIPTIONS'],
  /**
   * 45 days. Far enough ahead to cover next month's bill from anywhere in this
   * month, short enough that nothing on the list is idle speculation.
   */
  horizonDays: 45,
  /** Two days of drift is a fixed billing date landing around a weekend. */
  highConfidenceSpreadDays: 2,
  // (both measured on the day of the month, not on the gap between charges —
  // see `predictUpcomingBills` for why that distinction matters)
  /**
   * Beyond a week of drift there is no date worth naming — the bill is monthly
   * but its date is not predictable, and saying so is better than inventing one.
   */
  maxSpreadDays: 7,
};

export interface UpcomingBill {
  merchant: string;
  category: string;
  /** ISO date the next charge is expected. Predicted, never observed. */
  expectedDate: string;
  /** The typical amount, as a positive magnitude. Also an expectation. */
  expectedAmount: number;
  /** ISO date of the most recent actual charge this is projected from. */
  lastCharged: string;
  /** Days from the last charge to the projected one. */
  cadenceDays: number;
  /** The day of the month this bill lands on. */
  expectedDay: number;
  /** How tightly the observed gaps cluster. */
  confidence: 'high' | 'medium';
  /** How many charges the cadence is drawn from. */
  observations: number;
}

export type UpcomingOptions = Partial<UpcomingThresholds> & {
  month: string;
  /** The day predictions are made relative to. Defaults to the month's end. */
  asOf?: string;
};

/**
 * The bills expected in the next `horizonDays`, soonest first.
 *
 * A prediction that has already come and gone is dropped rather than shown as
 * overdue: this feature answers "what is coming", and the absence of a charge
 * is not something a statement can confirm — the bill may have been paid from
 * another account, or the import may simply not have caught up.
 */
export function predictUpcomingBills(
  transactions: IndiaTransaction[],
  options: UpcomingOptions,
): UpcomingBill[] {
  const config = { ...UPCOMING_DEFAULTS, ...options };
  const asOf = config.asOf ?? lastDayOf(config.month);

  // `findRecurringCharges` reads the Phase 6 shape, which is this one minus the
  // description. Handing it the same rows keeps one definition of "recurring".
  const rows: AnomalyTransaction[] = transactions.map((t) => ({
    id: t.id,
    date: t.date,
    amount: t.amount,
    category: t.category,
    normalizedMerchant: t.normalizedMerchant,
  }));

  const upcoming: UpcomingBill[] = [];

  for (const charge of findRecurringCharges(rows, {
    month: config.month,
    lookbackMonths: config.lookbackMonths,
  })) {
    if (!config.categories.includes(charge.category)) continue;

    const occurrences = charge.occurrences;
    if (occurrences.length < 2) continue;

    // Projected by **day of the month**, not by adding an average gap.
    //
    // A bill charged on the 17th of April, May and June has gaps of 30 and 31
    // days; adding their mean lands on the 18th of July and every subsequent
    // projection drifts further. The bill is not "every 30.5 days", it is "the
    // 17th" — and on the 31st it is "the 31st, or the last day the month has",
    // which is why the date is clamped rather than allowed to roll over.
    const days = occurrences.map((t) => dayOf(t.date));
    const expectedDay = Math.round(median(days));
    const spread = Math.max(...days.map((d) => dayOfMonthDistance(d, expectedDay)));
    if (spread > config.maxSpreadDays) continue;

    const last = occurrences[occurrences.length - 1];
    const expectedDate = dateInMonth(addMonths(monthOf(last.date), 1), expectedDay);
    const cadenceDays = daysBetween(last.date, expectedDate);

    // Already due or past: not a prediction any more.
    if (expectedDate <= asOf) continue;
    if (daysBetween(asOf, expectedDate) > config.horizonDays) continue;

    upcoming.push({
      merchant: charge.merchant,
      category: charge.category,
      expectedDate,
      expectedAmount: round2(median(occurrences.map((t) => t.amount))),
      lastCharged: last.date,
      cadenceDays,
      expectedDay,
      confidence: spread <= config.highConfidenceSpreadDays ? 'high' : 'medium',
      observations: occurrences.length,
    });
  }

  return upcoming.sort((a, b) =>
    a.expectedDate < b.expectedDate
      ? -1
      : a.expectedDate > b.expectedDate
        ? 1
        : a.merchant < b.merchant
          ? -1
          : 1,
  );
}

/** The total expected to leave the account across every prediction. */
export function totalUpcoming(bills: UpcomingBill[]): number {
  return round2(bills.reduce((sum, b) => sum + b.expectedAmount, 0));
}

function lastDayOf(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

/** Re-exported so callers can group predictions without re-deriving the month. */
export const billMonth = monthOf;
