/**
 * SIP and recurring-investment tracking.
 *
 * A systematic investment plan is an EMI that buys something instead of paying
 * something off, and it is detected the same way — a stable amount on a stable
 * day, month after month — with two differences that matter:
 *
 *   * The **category** does the qualifying, not a keyword. Phase 14 already
 *     routes Zerodha, Groww, Upstox, the AMCs and the literal word "SIP" to
 *     `INVESTMENTS`, so re-deriving that here would be a second rule set to
 *     keep in step with the first.
 *   * The **amount band is wider** (5%, not the EMI's 2%). An instalment is a
 *     contract; a SIP is a standing instruction that a fund house can round,
 *     and a step-up SIP raises itself deliberately. Too tight a band and a
 *     perfectly ordinary SIP stops being recognised the month it steps up.
 *
 * The headline number is the total monthly outgo and what share of income it
 * represents — which needs a salary figure, and so is only offered when
 * `salary.ts` actually found one. An investment rate computed against a number
 * that is not income would be worse than no number at all.
 */
import { median } from '../anomalies/statistics';
import {
  addMonths,
  dayOf,
  dayOfMonthDistance,
  monthOf,
  round2,
  trailingMonths,
  type IndiaTransaction,
} from './types';

export interface SipThresholds {
  lookbackMonths: number;
  /** Instalments needed before a plan is claimed. */
  minOccurrences: number;
  /** How far a contribution may sit from the median and still be "the same". */
  amountTolerance: number;
  /** How far the debit day may drift. */
  dayTolerance: number;
  /** Below this, a small regular buy is not a plan worth reporting. */
  minAmount: number;
  /** Months with no contribution before a plan is treated as stopped. */
  staleMonths: number;
}

export const SIP_DEFAULTS: SipThresholds = {
  lookbackMonths: 12,
  /** Three, for the same reason EMIs need three: two is a coincidence. */
  minOccurrences: 3,
  /**
   * 5%. Wider than an EMI's 2% because a SIP legitimately moves — a fund house
   * rounds to whole units, and a step-up SIP raises itself by design — but far
   * tighter than ordinary spending, which is what keeps two trips to the same
   * broker out.
   */
  amountTolerance: 0.05,
  dayTolerance: 4,
  /** ₹500 is the smallest SIP most Indian fund houses will accept. */
  minAmount: 500,
  staleMonths: 2,
};

export interface DetectedSip {
  /** The fund house or broker, as normalized. */
  merchant: string;
  /** The monthly contribution, as a positive magnitude. */
  monthlyAmount: number;
  /** Day of the month it is debited. */
  debitDay: number;
  firstSeen: string;
  lastSeen: string;
  contributionsObserved: number;
  /** False once it has missed `staleMonths` months — probably stopped. */
  active: boolean;
}

export type SipOptions = Partial<SipThresholds> & { month: string };

/** Every recurring investment debit visible in the window, largest first. */
export function detectSips(transactions: IndiaTransaction[], options: SipOptions): DetectedSip[] {
  const config = { ...SIP_DEFAULTS, ...options };
  const window = new Set(trailingMonths(config.month, config.lookbackMonths));

  const byMerchant = new Map<string, IndiaTransaction[]>();
  for (const t of transactions) {
    if (t.amount <= 0 || !t.normalizedMerchant) continue;
    if (t.category !== 'INVESTMENTS') continue;
    if (!window.has(monthOf(t.date))) continue;
    const bucket = byMerchant.get(t.normalizedMerchant);
    if (bucket) bucket.push(t);
    else byMerchant.set(t.normalizedMerchant, [t]);
  }

  const found: DetectedSip[] = [];

  byMerchant.forEach((rows, merchant) => {
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));

    // A SIP debits once a month. Somebody buying stocks whenever they feel like
    // it is investing, but it is not a plan with a monthly figure.
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

    const months = sorted.map((t) => monthOf(t.date));
    for (let i = 1; i < months.length; i++) {
      if (months[i] !== addMonths(months[i - 1], 1)) return;
    }

    if (sorted.length < config.minOccurrences) return;

    const lastMonth = months[months.length - 1];
    const [ly, lm] = lastMonth.split('-').map(Number);
    const [cy, cm] = config.month.split('-').map(Number);
    const active = (cy - ly) * 12 + (cm - lm) < config.staleMonths;

    found.push({
      merchant,
      monthlyAmount: round2(reference),
      debitDay,
      firstSeen: sorted[0].date,
      lastSeen: sorted[sorted.length - 1].date,
      contributionsObserved: sorted.length,
      active,
    });
  });

  return found.sort(
    (a, b) => b.monthlyAmount - a.monthlyAmount || (a.merchant < b.merchant ? -1 : 1),
  );
}

export interface SipSummary {
  plans: DetectedSip[];
  /** What leaves every month across every plan still running. */
  totalMonthly: number;
  /**
   * `totalMonthly / monthlyIncome`, or null when no salary was found.
   *
   * Null, not zero: without an income figure the share is unknown, and an
   * unknown share shown as 0% reads as "you are investing nothing".
   */
  shareOfIncome: number | null;
}

export function summariseSips(plans: DetectedSip[], monthlyIncome: number | null): SipSummary {
  const totalMonthly = round2(
    plans.filter((p) => p.active).reduce((sum, p) => sum + p.monthlyAmount, 0),
  );

  return {
    plans,
    totalMonthly,
    shareOfIncome:
      monthlyIncome !== null && monthlyIncome > 0
        ? Math.round((totalMonthly / monthlyIncome) * 1000) / 1000
        : null,
  };
}
