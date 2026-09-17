/**
 * The Phase 19 detectors, assembled into one answer.
 *
 * Five statistics-only features (PROJECT_CONTEXT.md §4 puts all of them on the
 * "no model call" side of the architecture), each a pure function of the rows
 * handed in. This module does nothing but run them over the same set of
 * transactions and hand back one object, so the route has no logic in it and
 * every threshold stays where it is documented.
 *
 * `docs/INDIA_FEATURES.md` is the tuning guide: every threshold below has an
 * entry there saying what it means and why it is where it is.
 */
import { detectEmis, nextInstalmentDate, totalMonthlyEmi, type DetectedEmi } from './emi';
import { detectFestiveSpending, type FestiveNote } from './festive';
import { detectSalary, savingsRate, type DetectedSalary, type SavingsRate } from './salary';
import { detectSips, summariseSips, type SipSummary } from './sip';
import { predictUpcomingBills, totalUpcoming, type UpcomingBill } from './upcoming';
import { round2, type IndiaTransaction } from './types';

export interface LoanSummary {
  loans: (DetectedEmi & { nextInstalment: string | null })[];
  /** What leaves every month across every instalment still running. */
  totalMonthly: number;
  /** `totalMonthly / monthlyIncome`, or null when no salary was found. */
  shareOfIncome: number | null;
}

export interface IndiaInsights {
  month: string;
  /** Null when nothing in the window behaves like employment income. */
  salary: DetectedSalary | null;
  savings: SavingsRate;
  loans: LoanSummary;
  investments: SipSummary;
  /** Predictions, never observations. Empty when nothing is confidently due. */
  upcoming: { bills: UpcomingBill[]; totalExpected: number };
  /** Null unless the month overlaps a festive window and something moved. */
  festive: FestiveNote | null;
}

export interface IndiaOptions {
  month: string;
  /** The day predictions are made relative to. Defaults to the month's end. */
  asOf?: string;
}

export function buildIndiaInsights(
  transactions: IndiaTransaction[],
  options: IndiaOptions,
): IndiaInsights {
  const { month, asOf } = options;

  const salary = detectSalary(transactions, { month });
  // Everything that divides by income divides by the *salary*, not by the
  // month's total credits. A month with a bonus in it would otherwise make the
  // EMI and SIP shares look smaller than the commitment really is.
  const monthlyIncome = salary?.monthlyAmount ?? null;

  const emis = detectEmis(transactions, { month });
  const totalMonthly = totalMonthlyEmi(emis);

  const bills = predictUpcomingBills(transactions, { month, ...(asOf ? { asOf } : {}) });

  return {
    month,
    salary,
    savings: savingsRate(transactions, month),
    loans: {
      loans: emis.map((emi) => ({ ...emi, nextInstalment: nextInstalmentDate(emi) })),
      totalMonthly,
      shareOfIncome:
        monthlyIncome !== null && monthlyIncome > 0
          ? Math.round((totalMonthly / monthlyIncome) * 1000) / 1000
          : null,
    },
    investments: summariseSips(detectSips(transactions, { month }), monthlyIncome),
    upcoming: { bills, totalExpected: round2(totalUpcoming(bills)) },
    festive: detectFestiveSpending(transactions, { month }),
  };
}

export type { DetectedEmi, DetectedSalary, FestiveNote, SavingsRate, SipSummary, UpcomingBill };
export type { IndiaTransaction } from './types';
