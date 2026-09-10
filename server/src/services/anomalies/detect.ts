/**
 * Anomaly detection — pure statistics, no LLM.
 *
 * Everything here is a deterministic function of the transactions handed in, so
 * the same data always produces the same flags and every threshold can be tested
 * directly. PROJECT_CONTEXT.md §4 puts this squarely on the "no model call"
 * side of the architecture: an insight a user is asked to act on should be
 * reproducible and explainable, not generated.
 *
 * Four detectors, each answering a different question:
 *
 *   UNUSUAL_AMOUNT              is this charge large for its category?
 *   NEW_RECURRING_CHARGE        has something started billing me monthly?
 *   SUBSCRIPTION_PRICE_INCREASE has something I already pay for got dearer?
 *   CATEGORY_SPEND_SPIKE        did a whole category jump this month?
 *
 * The hard part is not finding anomalies, it is not crying wolf. Every detector
 * below carries a materiality floor as well as a ratio, because "300% above
 * average" on a ₹150 baseline is noise, and a review queue full of noise is one
 * nobody reads.
 */
import type { AnomalySeverity, AnomalyType, Category } from '../../generated/prisma/enums';
import { formatINR } from '../../utils/currency';
import { median, upperFence, zScore } from './statistics';

/** The fields detection reads. */
export interface AnomalyTransaction {
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Debit-positive: purchases positive, refunds and income negative. */
  amount: number;
  category: Category;
  normalizedMerchant: string;
  /**
   * How much of this charge came back as a linked refund (§8 case 2). A sofa
   * bought and returned is not an unusual amount of furniture spending — it is
   * no furniture spending — so outlier detection judges what was kept.
   */
  refunded?: number;
}

export interface DetectedAnomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  /** Calendar month the flag belongs to, YYYY-MM. */
  month: string;
  transactionId?: string;
  explanation: string;
  /**
   * Stable identity for this finding. Re-running detection over the same data
   * produces the same fingerprint, which is what makes the pass idempotent and
   * lets a dismissal stick instead of reappearing on the next run.
   */
  fingerprint: string;
}

/**
 * Categories detection ignores.
 *
 * TRANSFER and INCOME are not spending (§5), and a REFUND that could not be
 * linked back to a purchase has no category of its own to be judged against.
 * UNCATEGORIZED is excluded for a different reason: it is a review queue rather
 * than a category, so "unusually large for UNCATEGORIZED" would be a statement
 * about our own coverage rather than about the user's money.
 */
const NOT_ANALYSED: Category[] = ['TRANSFER', 'INCOME', 'REFUND', 'UNCATEGORIZED'];

export interface DetectionThresholds {
  /** Months of history considered, including the month being analysed. */
  lookbackMonths: number;
  outlierIqrMultiplier: number;
  outlierMinSample: number;
  outlierMinAmount: number;
  recurringMinGapDays: number;
  recurringMaxGapDays: number;
  recurringAmountTolerance: number;
  recurringMinOccurrences: number;
  recurringMaxPerMonth: number;
  newChargeMinHistoryDays: number;
  priceChangeRunTolerance: number;
  priceStableTolerance: number;
  priceStableOccurrences: number;
  priceChangeMinRatio: number;
  priceChangeMinAbsolute: number;
  spikeMinRatio: number;
  spikeMinAbsolute: number;
  spikeMinMonths: number;
}

export const DEFAULTS: DetectionThresholds = {
  /** Months of history considered, including the month being analysed. */
  lookbackMonths: 6,

  /** Tukey multiplier for the per-category outlier fence. */
  outlierIqrMultiplier: 1.5,
  /** Below this many observations a category has no distribution worth trusting. */
  outlierMinSample: 8,
  /**
   * A charge smaller than this is never "unusual", however odd the category.
   * ₹4,000 is about where a charge stops being an ordinary errand — a tank of
   * fuel, a family dinner, a doctor's visit all sit below it, and none of them
   * is worth interrupting somebody over however far above their own category
   * median they happen to land.
   */
  outlierMinAmount: 4000,

  /** A gap between charges inside this band counts as monthly. */
  recurringMinGapDays: 24,
  recurringMaxGapDays: 38,
  /** Amounts within this fraction of each other count as "the same charge". */
  recurringAmountTolerance: 0.15,
  /** Charges must repeat at least this many times before a cadence is claimed. */
  recurringMinOccurrences: 2,
  /**
   * A merchant billing more than this many times in any month is not a
   * subscription, whatever the spacing of some subset of its charges. This is
   * the single strongest signal: you are billed by Netflix once a month and you
   * buy coffee eight times.
   */
  recurringMaxPerMonth: 1,
  /**
   * How long the account must have been observed before a first charge for
   * "new" to mean anything. Without it, the oldest month of any import is a
   * wall of false positives: every subscription the user already had looks new,
   * because there is no history in front of it to contradict that.
   */
  newChargeMinHistoryDays: 45,

  /**
   * A price change breaks the "same amount" rule by definition, so runs are
   * rebuilt with a wider tolerance when hunting for one — wide enough to hold a
   * typical subscription rise, narrow enough that a bill which is different
   * every month never forms a run at all.
   */
  priceChangeRunTolerance: 0.35,
  /** How close the charges before a change must be to count as "the old price". */
  priceStableTolerance: 0.02,
  /** ...and how many of them there must be. */
  priceStableOccurrences: 2,

  /** A subscription price move smaller than either of these is not material. */
  priceChangeMinRatio: 0.05,
  /** ₹20 — below a rupee or two of GST rounding on a streaming plan. */
  priceChangeMinAbsolute: 20,

  /** A month must exceed the trailing median by this fraction to be a spike. */
  spikeMinRatio: 0.5,
  /**
   * ...and by this many rupees, so a tiny category cannot spike. ₹5,000 is
   * roughly a fortnight of groceries: enough that a flagged month is one a
   * person would actually recognise as heavier than usual.
   */
  spikeMinAbsolute: 5000,
  /** Months of history needed before a baseline means anything. */
  spikeMinMonths: 2,
};

export type DetectOptions = Partial<DetectionThresholds> & { month: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const monthOf = (date: string): string => date.slice(0, 7);

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** The `count` months ending at `month`, oldest first. */
export function trailingMonths(month: string, count: number): string[] {
  const [year, index] = month.split('-').map(Number);
  const months: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const d = new Date(Date.UTC(year, index - 1 - back, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

/**
 * Rounds to cents. Monthly totals are sums of floats, and a sum is only
 * associative in mathematics — without this, the same month adds up to a
 * hundredth of a cent more or less depending on row order, which is enough to
 * make an explanation string differ between runs.
 */
const roundCents = (amount: number): number => Math.round(amount * 100) / 100;

const money = (amount: number): string => formatINR(amount);

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/** Spending categories, whatever the sign — a refund nets against its category. */
const isSpendCategory = (t: AnomalyTransaction): boolean => !NOT_ANALYSED.includes(t.category);

/** What a charge cost after anything returned against it came back. */
const netAmount = (t: AnomalyTransaction): number => t.amount - (t.refunded ?? 0);

/** An actual charge: money going out, in a category that counts as spending. */
const isSpend = (t: AnomalyTransaction): boolean => isSpendCategory(t) && netAmount(t) > 0;

function severityFrom(ratio: number, medium: number, high: number): AnomalySeverity {
  if (ratio >= high) return 'HIGH';
  if (ratio >= medium) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// 1. Per-category outliers
// ---------------------------------------------------------------------------

/**
 * Flags a charge that is large for its own category.
 *
 * The distribution is built from the whole lookback window, so a category is
 * judged against its own habits rather than a global threshold — $180 is
 * unremarkable for HOUSING and extraordinary for DINING.
 *
 * The fence is Tukey's rather than a standard-deviation band on purpose: one
 * $3,299 laptop inflates a standard deviation enough to hide itself, which is
 * the masking problem §8 case 10 warns about. The z-score is still reported in
 * the explanation, because it is the number people recognise.
 */
export function detectAmountOutliers(
  transactions: AnomalyTransaction[],
  options: DetectOptions,
): DetectedAnomaly[] {
  const config = { ...DEFAULTS, ...options };
  const window = new Set(trailingMonths(config.month, config.lookbackMonths));
  const inWindow = transactions.filter((t) => isSpend(t) && window.has(monthOf(t.date)));

  const byCategory = new Map<Category, AnomalyTransaction[]>();
  inWindow.forEach((t) => {
    const bucket = byCategory.get(t.category);
    if (bucket) bucket.push(t);
    else byCategory.set(t.category, [t]);
  });

  const anomalies: DetectedAnomaly[] = [];

  byCategory.forEach((rows, category) => {
    if (rows.length < config.outlierMinSample) return;

    const amounts = rows.map(netAmount);
    const fence = upperFence(amounts, config.outlierIqrMultiplier);
    if (fence.iqr === 0) return;

    rows
      .filter((t) => monthOf(t.date) === config.month)
      .filter((t) => netAmount(t) > fence.upper && netAmount(t) >= config.outlierMinAmount)
      .forEach((t) => {
        const amount = netAmount(t);
        const timesTypical = amount / Math.max(fence.q3, 0.01);
        anomalies.push({
          type: 'UNUSUAL_AMOUNT',
          severity: severityFrom(amount / fence.upper, 1.5, 3),
          month: config.month,
          transactionId: t.id,
          explanation:
            `${money(amount)} at ${t.normalizedMerchant} is unusually large for ${category}. ` +
            `Most ${category} charges are under ${money(fence.q3)} ` +
            `(${timesTypical.toFixed(1)}x that, ${zScore(amount, amounts).toFixed(1)} standard deviations above average).`,
          // The category is part of the identity because a split transaction
          // contributes one row per part, each judged against its own category.
          fingerprint: `UNUSUAL_AMOUNT:${t.id}:${category}`,
        });
      });
  });

  return anomalies;
}

// ---------------------------------------------------------------------------
// Recurring-charge detection, shared by 2 and 3
// ---------------------------------------------------------------------------

export interface RecurringCharge {
  merchant: string;
  category: Category;
  /** The charges that form the monthly run, oldest first. */
  occurrences: AnomalyTransaction[];
}

/**
 * Finds merchants billing on a roughly monthly cadence.
 *
 * Two tests, and the first one does most of the work. A merchant that charges
 * more than once in any month is not billing monthly, whatever the spacing of
 * some subset of its charges — and over six months of real spending there is
 * almost always *some* pair of coffees 30 days apart for similar money. Without
 * this gate every frequent merchant eventually looks like a subscription, which
 * is the false positive §8 case 5 warns about: a legitimately repeated small
 * charge must not be mistaken for something else.
 *
 * What survives that gate is then walked for a run of charges spaced 24-38 days
 * apart at a stable amount, which is what a subscription actually looks like.
 */
export function findRecurringCharges(
  transactions: AnomalyTransaction[],
  options: DetectOptions,
): RecurringCharge[] {
  const config = { ...DEFAULTS, ...options };
  const window = new Set(trailingMonths(config.month, config.lookbackMonths));

  const byMerchant = new Map<string, AnomalyTransaction[]>();
  transactions
    .filter((t) => isSpend(t) && t.normalizedMerchant && window.has(monthOf(t.date)))
    .forEach((t) => {
      const bucket = byMerchant.get(t.normalizedMerchant);
      if (bucket) bucket.push(t);
      else byMerchant.set(t.normalizedMerchant, [t]);
    });

  const recurring: RecurringCharge[] = [];

  byMerchant.forEach((rows, merchant) => {
    // Billed more than once in some month: everyday spending, not a plan.
    const perMonth = new Map<string, number>();
    rows.forEach((t) => perMonth.set(monthOf(t.date), (perMonth.get(monthOf(t.date)) ?? 0) + 1));
    if ([...perMonth.values()].some((count) => count > config.recurringMaxPerMonth)) return;

    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Walk the charges and grow the longest run of monthly-spaced, similar
    // amounts. A merchant billed twice in one week breaks the run rather than
    // extending it.
    let best: AnomalyTransaction[] = [];
    let run: AnomalyTransaction[] = [];

    for (const transaction of sorted) {
      if (run.length === 0) {
        run = [transaction];
        continue;
      }
      const previous = run[run.length - 1];
      const gap = daysBetween(previous.date, transaction.date);
      const reference = median(run.map((t) => t.amount));
      const similar =
        reference > 0 &&
        Math.abs(transaction.amount - reference) / reference <= config.recurringAmountTolerance;

      if (gap >= config.recurringMinGapDays && gap <= config.recurringMaxGapDays && similar) {
        run.push(transaction);
      } else if (gap > config.recurringMaxGapDays || !similar) {
        // `>=` so that equal-length runs resolve to the most recent one: the
        // question is always about the month being analysed, and a cadence that
        // ended in the spring says nothing about it.
        if (run.length >= best.length) best = run;
        run = [transaction];
      }
      // A gap below the minimum is an extra charge inside the same period; it
      // neither extends nor breaks the run.
    }
    if (run.length >= best.length) best = run;

    if (best.length >= config.recurringMinOccurrences) {
      recurring.push({ merchant, category: best[0].category, occurrences: best });
    }
  });

  return recurring.sort((a, b) => (a.merchant < b.merchant ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 2. New recurring charges
// ---------------------------------------------------------------------------

/**
 * Flags a merchant that has started billing monthly and was not billing before.
 *
 * The flag lands in the month the cadence becomes visible — the second charge —
 * because one charge is a purchase and two a month apart is a subscription.
 * Claiming it a month earlier would mean flagging every one-off purchase as a
 * new subscription.
 *
 * "New" is a claim about absence, so it needs enough history behind it to be
 * worth making: a charge in the first weeks of an import is not new, it is
 * merely the first time we happened to be looking.
 */
export function detectNewRecurringCharges(
  transactions: AnomalyTransaction[],
  options: DetectOptions,
): DetectedAnomaly[] {
  const config = { ...DEFAULTS, ...options };
  const anomalies: DetectedAnomaly[] = [];

  const observedFrom = transactions.reduce<string | null>(
    (earliest, t) => (earliest === null || t.date < earliest ? t.date : earliest),
    null,
  );

  for (const charge of findRecurringCharges(transactions, config)) {
    const confirming = charge.occurrences[config.recurringMinOccurrences - 1];
    if (!confirming || monthOf(confirming.date) !== config.month) continue;

    const first = charge.occurrences[0];
    if (observedFrom === null) continue;
    if (daysBetween(observedFrom, first.date) < config.newChargeMinHistoryDays) continue;
    // "New" means nothing from this merchant before the run began. Anything
    // earlier makes it an existing relationship, not a new subscription.
    const hadHistory = transactions.some(
      (t) => t.normalizedMerchant === charge.merchant && t.date < first.date,
    );
    if (hadHistory) continue;

    const amount = median(charge.occurrences.map((t) => t.amount));
    anomalies.push({
      type: 'NEW_RECURRING_CHARGE',
      severity: severityFrom(amount, 25, 75),
      month: config.month,
      transactionId: confirming.id,
      explanation:
        `${charge.merchant} looks like a new recurring charge of about ${money(amount)} a month. ` +
        `First seen ${first.date}, charged again ${confirming.date}, and not present before that.`,
      fingerprint: `NEW_RECURRING_CHARGE:${charge.merchant}:${first.date}`,
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// 3. Subscription price increases
// ---------------------------------------------------------------------------

/**
 * Flags a recurring charge whose amount has risen materially.
 *
 * Three things have to hold, and the third is what keeps a variable bill out of
 * the results. A ratio and an absolute floor both have to be cleared — a 6%
 * rise on a $2.99 cloud plan is eighteen cents, while the same 6% on a $60 plan
 * is worth knowing. And the charges *before* the rise have to have been at one
 * settled amount: a price can only go up from a price. A utility bill that is a
 * different number every month has not been repriced, it is just weather, and
 * flagging it every warm month is how an insights panel gets ignored.
 */
export function detectSubscriptionPriceIncreases(
  transactions: AnomalyTransaction[],
  options: DetectOptions,
): DetectedAnomaly[] {
  const config = { ...DEFAULTS, ...options };
  const anomalies: DetectedAnomaly[] = [];

  for (const charge of findRecurringCharges(transactions, {
    ...config,
    recurringAmountTolerance: config.priceChangeRunTolerance,
  })) {
    for (let i = 1; i < charge.occurrences.length; i++) {
      const before = charge.occurrences[i - 1];
      const after = charge.occurrences[i];
      if (monthOf(after.date) !== config.month) continue;

      const difference = after.amount - before.amount;
      if (difference <= 0) continue;

      const ratio = difference / before.amount;
      if (ratio < config.priceChangeMinRatio) continue;
      if (difference < config.priceChangeMinAbsolute) continue;

      // Establish that there was an old price to rise from.
      const settled = charge.occurrences.slice(Math.max(0, i - config.priceStableOccurrences), i);
      if (settled.length < config.priceStableOccurrences) continue;
      const wasStable = settled.every(
        (t) => Math.abs(t.amount - before.amount) <= before.amount * config.priceStableTolerance,
      );
      if (!wasStable) continue;

      anomalies.push({
        type: 'SUBSCRIPTION_PRICE_INCREASE',
        severity: severityFrom(ratio, 0.1, 0.25),
        month: config.month,
        transactionId: after.id,
        explanation:
          `${charge.merchant} went up from ${money(before.amount)} to ${money(after.amount)} ` +
          `(+${percent(ratio)}, ${money(difference)} more a month, about ${money(difference * 12)} a year).`,
        fingerprint: `SUBSCRIPTION_PRICE_INCREASE:${charge.merchant}:${after.date}`,
      });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// 4. Category spend spikes
// ---------------------------------------------------------------------------

/**
 * Flags a category whose month is well above its own recent baseline.
 *
 * The baseline is the *median* of the trailing months rather than the mean, so
 * one extraordinary month does not raise the bar and hide the next one — the
 * same masking problem the outlier fence avoids.
 *
 * Monthly totals are net, matching the dashboard: a refund attributed back to
 * the category it offsets reduces that month rather than sitting in a bucket of
 * its own. An insight panel that disagreed with the chart beside it would be
 * read as a bug in both.
 */
export function detectCategorySpikes(
  transactions: AnomalyTransaction[],
  options: DetectOptions,
): DetectedAnomaly[] {
  const config = { ...DEFAULTS, ...options };
  const months = trailingMonths(config.month, config.lookbackMonths);
  const priorMonths = months.filter((m) => m !== config.month);

  const totals = new Map<Category, Map<string, number>>();
  transactions
    .filter((t) => isSpendCategory(t) && months.includes(monthOf(t.date)))
    .forEach((t) => {
      const byMonth = totals.get(t.category) ?? new Map<string, number>();
      const month = monthOf(t.date);
      byMonth.set(month, roundCents((byMonth.get(month) ?? 0) + t.amount));
      totals.set(t.category, byMonth);
    });

  const anomalies: DetectedAnomaly[] = [];

  totals.forEach((byMonth, category) => {
    const current = byMonth.get(config.month) ?? 0;
    const baselineMonths = priorMonths.filter((m) => byMonth.has(m));
    if (baselineMonths.length < config.spikeMinMonths) return;

    const baseline = roundCents(median(baselineMonths.map((m) => byMonth.get(m)!)));
    if (baseline <= 0) return;

    const increase = roundCents(current - baseline);
    const ratio = increase / baseline;
    if (ratio < config.spikeMinRatio) return;
    if (increase < config.spikeMinAbsolute) return;

    anomalies.push({
      type: 'CATEGORY_SPEND_SPIKE',
      severity: severityFrom(ratio, 1, 2),
      month: config.month,
      explanation:
        `${category} came to ${money(current)} this month, ${percent(ratio)} above the ` +
        `${money(baseline)} typical of the previous ${baselineMonths.length} months ` +
        `(${money(increase)} more than usual).`,
      fingerprint: `CATEGORY_SPEND_SPIKE:${category}:${config.month}`,
    });
  });

  return anomalies;
}

// ---------------------------------------------------------------------------
// All of them
// ---------------------------------------------------------------------------

/** Runs every detector over one month and returns the findings, most severe first. */
export function detectAnomalies(
  transactions: AnomalyTransaction[],
  options: DetectOptions,
): DetectedAnomaly[] {
  const found = [
    ...detectAmountOutliers(transactions, options),
    ...detectNewRecurringCharges(transactions, options),
    ...detectSubscriptionPriceIncreases(transactions, options),
    ...detectCategorySpikes(transactions, options),
  ];

  const rank: Record<AnomalySeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return found.sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return a.fingerprint < b.fingerprint ? -1 : 1;
  });
}
