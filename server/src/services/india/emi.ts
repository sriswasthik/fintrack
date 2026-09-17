/**
 * EMI and loan tracking.
 *
 * An EMI — equated monthly instalment — is the most rigid thing in an Indian
 * bank statement: the *same* amount, on the *same* day, every month, until the
 * tenure ends. That rigidity is what makes it detectable without a model, and
 * it is also what separates it from the false positive the brief names: two
 * unrelated transfers that happen to be for similar money.
 *
 * Three gates, and each one on its own kills that false positive:
 *
 *   1. **Three occurrences.** Two of anything is a coincidence.
 *   2. **A 2% amount band, not 15%.** A subscription drifts with GST and a
 *      grocery bill drifts with the groceries; an instalment does not drift at
 *      all. Holding EMIs to a far tighter band than Phase 6 holds subscriptions
 *      is the point, not an oversight.
 *   3. **A stable day of the month.** Auto-debits land on their mandate date.
 *
 * Either the Phase 14 `EMI_LOAN` category or an EMI-shaped narration gets a row
 * considered; neither on its own is enough to be *reported*, because all three
 * gates above still have to pass.
 */
import { median } from '../anomalies/statistics';
import {
  addMonths,
  dateInMonth,
  dayOf,
  dayOfMonthDistance,
  monthOf,
  round2,
  trailingMonths,
  type IndiaTransaction,
} from './types';

export interface EmiThresholds {
  lookbackMonths: number;
  /** Instalments needed before a commitment is claimed. */
  minOccurrences: number;
  /** How far an instalment may sit from the median and still be "the same". */
  amountTolerance: number;
  /** How far the debit day may drift and still be "the same day". */
  dayTolerance: number;
  /** Below this, a small standing debit is not worth calling a loan. */
  minAmount: number;
  /** Months with no instalment before a commitment is treated as finished. */
  staleMonths: number;
  /** Common Indian loan tenures, in months, for the remaining-tenure estimate. */
  commonTenures: number[];
}

export const EMI_DEFAULTS: EmiThresholds = {
  lookbackMonths: 12,
  /**
   * Three. This is the gate that rejects "two unrelated transfers of a similar
   * amount" — the false positive the brief calls out by name.
   */
  minOccurrences: 3,
  /**
   * 2%. An instalment is a contract, not a bill: the number does not move.
   * Phase 6 allows subscriptions 15% because a subscription genuinely drifts;
   * allowing an EMI the same would let two similar transfers in as a loan.
   */
  amountTolerance: 0.02,
  /** Auto-debit mandates land on their date, give or take a weekend. */
  dayTolerance: 4,
  /** ₹1,000. Below this it is more likely a standing order than a loan. */
  minAmount: 1000,
  /** Two missed months and the loan is treated as closed rather than current. */
  staleMonths: 2,
  /**
   * The tenures Indian lenders actually write, shortest first. A personal loan
   * is 12/24/36, a consumer-durable EMI 3/6/9/12, a car loan 36/60, a home loan
   * 120/180/240. The estimate below snaps to the nearest of these that is still
   * ahead of the instalments already paid.
   */
  commonTenures: [3, 6, 9, 12, 18, 24, 36, 48, 60, 84, 120, 180, 240],
};

/** Narrations that mean an instalment even when the category does not say so. */
const EMI_PATTERNS: RegExp[] = [
  /\bEMI\b/i,
  /\bLOAN\s*EMI\b/i,
  /\bLOANEMI\b/i,
  /\bINSTALMENT\b/i,
  /\bINSTALLMENT\b/i,
  /\bACH[ -]?D[ -]/i,
  /\bNACH\b/i,
  /\bEQUATED\s+MONTHLY\b/i,
];

/** Whether a row is even a candidate. Being a candidate is not being an EMI. */
export function looksLikeEmi(t: IndiaTransaction): boolean {
  if (t.category === 'EMI_LOAN') return true;
  const haystack = `${t.description ?? ''} ${t.normalizedMerchant}`;
  return EMI_PATTERNS.some((pattern) => pattern.test(haystack));
}

export interface DetectedEmi {
  /** The lender or mandate reference, as normalized. */
  merchant: string;
  /** The instalment, as a positive magnitude. */
  monthlyAmount: number;
  /** Day of the month it is debited. */
  debitDay: number;
  /** ISO date of the earliest instalment observed. */
  firstSeen: string;
  /** ISO date of the most recent one. */
  lastSeen: string;
  /** How many instalments are visible in the data. Not how many were paid. */
  instalmentsObserved: number;
  /** False once it has missed `staleMonths` months — probably closed. */
  active: boolean;
  /**
   * A guess, and labelled as one everywhere it is shown.
   *
   * Null unless the observed run snaps cleanly to a common tenure. See
   * `estimateRemaining` for exactly how weak this inference is.
   */
  estimate: TenureEstimate | null;
}

export interface TenureEstimate {
  /** The tenure this was snapped to, in months. */
  assumedTenureMonths: number;
  /** Instalments left if that assumption holds. */
  remainingMonths: number;
  /** ISO month the last instalment would fall in. */
  projectedFinalMonth: string;
  /**
   * Always present, always shown. The estimate assumes the loan started with
   * the first instalment we can see and runs a standard tenure — and we cannot
   * see either fact.
   */
  caveat: string;
}

/**
 * A remaining-tenure guess, or null when the data will not support one.
 *
 * This is the weakest inference in the phase and it is treated as such. Two
 * things are unknowable from a bank statement: when the loan actually started
 * (the statement may begin mid-loan) and how long it runs. So the estimate
 * assumes the first instalment we can see is the first instalment there was,
 * snaps the tenure to the nearest standard one above that, and says so.
 *
 * It returns null rather than guessing when the observed run already exceeds
 * the longest tenure we know, or when the run is too short to snap sensibly.
 */
export function estimateRemaining(
  instalmentsObserved: number,
  lastMonth: string,
  config: EmiThresholds,
): TenureEstimate | null {
  const tenure = config.commonTenures.find((months) => months > instalmentsObserved);
  if (tenure === undefined) return null;

  const remainingMonths = tenure - instalmentsObserved;
  return {
    assumedTenureMonths: tenure,
    remainingMonths,
    projectedFinalMonth: addMonths(lastMonth, remainingMonths),
    caveat:
      `Estimate only. Assumes this loan began with the first instalment in your ` +
      `statements (${instalmentsObserved} seen) and runs a standard ${tenure}-month tenure. ` +
      `Your loan agreement is the only authority on what is actually left.`,
  };
}

export type EmiOptions = Partial<EmiThresholds> & { month: string };

/**
 * Every fixed monthly instalment visible in the window.
 *
 * Sorted largest first: if somebody has a home loan and a phone on EMI, the
 * home loan is the one they want to see at the top.
 */
export function detectEmis(transactions: IndiaTransaction[], options: EmiOptions): DetectedEmi[] {
  const config = { ...EMI_DEFAULTS, ...options };
  const window = new Set(trailingMonths(config.month, config.lookbackMonths));

  const byMerchant = new Map<string, IndiaTransaction[]>();
  for (const t of transactions) {
    if (t.amount <= 0 || !t.normalizedMerchant) continue;
    if (!window.has(monthOf(t.date))) continue;
    if (!looksLikeEmi(t)) continue;
    const bucket = byMerchant.get(t.normalizedMerchant);
    if (bucket) bucket.push(t);
    else byMerchant.set(t.normalizedMerchant, [t]);
  }

  const found: DetectedEmi[] = [];

  byMerchant.forEach((rows, merchant) => {
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));

    // One instalment per month, or it is not an instalment plan. Two debits
    // from the same lender in one month is a prepayment or a different product.
    const perMonth = new Map<string, number>();
    sorted.forEach((t) => perMonth.set(monthOf(t.date), (perMonth.get(monthOf(t.date)) ?? 0) + 1));
    if ([...perMonth.values()].some((count) => count > 1)) return;

    const amounts = sorted.map((t) => t.amount);
    const reference = median(amounts);
    if (reference < config.minAmount) return;
    if (amounts.some((a) => Math.abs(a - reference) / reference > config.amountTolerance)) return;

    const days = sorted.map((t) => dayOf(t.date));
    const debitDay = Math.round(median(days));
    if (days.some((d) => dayOfMonthDistance(d, debitDay) > config.dayTolerance)) return;

    // Consecutive months. A gap means this is not a running instalment plan.
    const months = sorted.map((t) => monthOf(t.date));
    for (let i = 1; i < months.length; i++) {
      if (months[i] !== addMonths(months[i - 1], 1)) return;
    }

    if (sorted.length < config.minOccurrences) return;

    const lastMonth = months[months.length - 1];
    const monthsSinceLast = monthGap(lastMonth, config.month);
    const active = monthsSinceLast < config.staleMonths;

    found.push({
      merchant,
      monthlyAmount: round2(reference),
      debitDay,
      firstSeen: sorted[0].date,
      lastSeen: sorted[sorted.length - 1].date,
      instalmentsObserved: sorted.length,
      active,
      estimate: active ? estimateRemaining(sorted.length, lastMonth, config) : null,
    });
  });

  return found.sort(
    (a, b) => b.monthlyAmount - a.monthlyAmount || (a.merchant < b.merchant ? -1 : 1),
  );
}

/** Whole months from `a` to `b`. */
function monthGap(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** The total leaving the account every month in instalments. */
export function totalMonthlyEmi(emis: DetectedEmi[]): number {
  return round2(emis.filter((e) => e.active).reduce((sum, e) => sum + e.monthlyAmount, 0));
}

/** Where the next instalment is expected, for an EMI still running. */
export function nextInstalmentDate(emi: DetectedEmi): string | null {
  if (!emi.active) return null;
  return dateInMonth(addMonths(monthOf(emi.lastSeen), 1), emi.debitDay);
}
