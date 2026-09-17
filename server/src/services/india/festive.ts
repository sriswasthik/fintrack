/**
 * Festive-season spending, stated neutrally.
 *
 * This is the feature with the most ways to go wrong, and almost none of them
 * are statistical. The risk is tone and overreach: it would be very easy to
 * write something that reads as a telling-off, or that asserts a *cause* the
 * data cannot support. "You overspent because of Diwali" is two claims, and the
 * statement supports neither — it supports "October was above your own
 * six-month average in Shopping and Dining, and October overlaps Diwali".
 *
 * So three rules run through everything below:
 *
 *   1. **The baseline is the user's own trailing months**, never a benchmark,
 *      an average Indian household, or anybody else. The comparison is always
 *      to themselves.
 *   2. **The festive window is a calendar fact, not a conclusion.** The note
 *      says the month overlaps one; it does not say the spending was caused by
 *      it, because nothing here can know that.
 *   3. **Nothing is said at all** unless the month clears both a ratio and a
 *      rupee floor. A month 8% above baseline is not news, and a category that
 *      went from ₹900 to ₹1,800 has doubled without anything happening.
 *
 * There is no "unusually high" and no exclamation mark anywhere in the output.
 * If a reader wants to conclude they overspent, that is theirs to conclude.
 */
import { median } from '../anomalies/statistics';
import { formatINR } from '../../utils/currency';
import { monthOf, round2, trailingMonths, type IndiaTransaction } from './types';

/**
 * A named shopping or festive window, by calendar month.
 *
 * Month-level on purpose. The lunar festivals move by weeks between years —
 * Diwali fell in October in 2025 and falls in November in 2026 — so a
 * date-level calendar would need maintaining every year and would be wrong the
 * moment it was not. A month either overlaps the window or it does not.
 *
 * `months` are 1-12. Windows may overlap; a month reports every one it touches.
 */
export interface FestiveWindow {
  key: string;
  label: string;
  months: number[];
  /** What the window is, in a clause that can be dropped into a sentence. */
  description: string;
}

export const FESTIVE_WINDOWS: FestiveWindow[] = [
  {
    key: 'dussehra-diwali',
    label: 'Dussehra and Diwali',
    // September through November: Dussehra can fall in early October or late
    // September, Diwali in October or November, and the sale season that trails
    // them runs to the end of November.
    months: [9, 10, 11],
    description: 'the Dussehra and Diwali period, when most large online sales run',
  },
  {
    key: 'year-end-sales',
    label: 'year-end sales',
    months: [12, 1],
    description: 'the year-end and new-year sale season',
  },
  {
    key: 'wedding-season',
    label: 'wedding season',
    months: [11, 12, 1, 2],
    description: 'the November-to-February wedding season',
  },
];

/** Which windows a YYYY-MM overlaps. Empty for an ordinary month. */
export function windowsFor(month: string): FestiveWindow[] {
  const index = Number(month.slice(5, 7));
  return FESTIVE_WINDOWS.filter((w) => w.months.includes(index));
}

export interface FestiveThresholds {
  /** Trailing months the baseline is drawn from, excluding the month itself. */
  baselineMonths: number;
  /** Baseline months with data needed before a comparison means anything. */
  minBaselineMonths: number;
  /** Categories this looks at. */
  categories: string[];
  /** How far above baseline the month must sit. */
  minRatio: number;
  /** ...and by how many rupees, so a small category cannot trip it. */
  minAbsolute: number;
}

export const FESTIVE_DEFAULTS: FestiveThresholds = {
  baselineMonths: 6,
  /**
   * Three. A "baseline" from one or two months is not a baseline, and the first
   * months of any import would otherwise produce a note about every festival.
   */
  minBaselineMonths: 3,
  /** What people actually buy more of in a festive season. */
  categories: ['SHOPPING', 'DINING', 'GIFTS_DONATIONS'],
  /**
   * 40% above their own median — deliberately *below* Phase 6's 50% spike
   * threshold, because this is an observation rather than an alert. It is worth
   * mentioning at a level that would not be worth interrupting somebody over.
   */
  minRatio: 0.4,
  /**
   * ₹8,000. A festive note is only worth writing about money somebody would
   * recognise as a real difference in the month.
   */
  minAbsolute: 8000,
};

export interface FestiveCategoryMove {
  category: string;
  /** What the month came to in this category. */
  amount: number;
  /** The median of the trailing months with data. */
  baseline: number;
  /** `amount / baseline - 1`. */
  ratio: number;
  /** `amount - baseline`, in rupees. */
  difference: number;
}

export interface FestiveNote {
  month: string;
  /** Every festive window this month overlaps. */
  windows: FestiveWindow[];
  /** The categories that cleared both thresholds, largest difference first. */
  categories: FestiveCategoryMove[];
  /** Total rupees above baseline across those categories. */
  totalAbove: number;
  /** How many trailing months the baseline was drawn from. */
  baselineMonths: number;
  /** A neutral sentence, safe to render as-is. */
  note: string;
}

export type FestiveOptions = Partial<FestiveThresholds> & { month: string };

/**
 * A note about this month's festive-season spending, or null.
 *
 * Null is the common and correct answer. It is returned when the month does not
 * overlap a festive window, when there is not enough history to have a baseline,
 * or when nothing moved enough to be worth a sentence.
 */
export function detectFestiveSpending(
  transactions: IndiaTransaction[],
  options: FestiveOptions,
): FestiveNote | null {
  const config = { ...FESTIVE_DEFAULTS, ...options };

  const windows = windowsFor(config.month);
  if (windows.length === 0) return null;

  // The baseline is the trailing months *before* this one. Including the month
  // being judged in its own baseline drags the baseline towards it and buries
  // exactly the move we are looking for.
  const baselineWindow = trailingMonths(config.month, config.baselineMonths + 1).filter(
    (m) => m !== config.month,
  );

  const moves: FestiveCategoryMove[] = [];

  for (const category of config.categories) {
    const inCategory = transactions.filter((t) => t.category === category);

    const monthTotal = round2(
      inCategory.filter((t) => monthOf(t.date) === config.month).reduce((s, t) => s + t.amount, 0),
    );
    if (monthTotal <= 0) continue;

    // Only months that actually have data. A month with no rows is a month
    // before the import began, not a month they spent nothing — counting it as
    // zero would halve the baseline and manufacture a finding.
    const baselineTotals = baselineWindow
      .map((m) =>
        round2(inCategory.filter((t) => monthOf(t.date) === m).reduce((s, t) => s + t.amount, 0)),
      )
      .filter((total) => total > 0);

    if (baselineTotals.length < config.minBaselineMonths) continue;

    // Rounded before the difference is taken, not after: the figures are shown
    // side by side, and a reader who subtracts the two numbers on screen has to
    // get the number on screen.
    const baseline = round2(median(baselineTotals));
    if (baseline <= 0) continue;

    const difference = round2(monthTotal - baseline);
    const ratio = difference / baseline;
    if (ratio < config.minRatio) continue;
    if (difference < config.minAbsolute) continue;

    moves.push({
      category,
      amount: monthTotal,
      baseline,
      ratio: Math.round(ratio * 1000) / 1000,
      difference,
    });
  }

  if (moves.length === 0) return null;

  moves.sort((a, b) => b.difference - a.difference);
  const totalAbove = round2(moves.reduce((s, m) => s + m.difference, 0));

  return {
    month: config.month,
    windows,
    categories: moves,
    totalAbove,
    baselineMonths: config.baselineMonths,
    note: phrase(config.month, windows, moves, totalAbove),
  };
}

/**
 * The sentence itself.
 *
 * Written to state two facts and draw no conclusion: what the categories came
 * to against their own median, and which window the month overlaps. No verdict,
 * no advice, no adjective doing work the numbers are not doing.
 */
function phrase(
  month: string,
  windows: FestiveWindow[],
  moves: FestiveCategoryMove[],
  totalAbove: number,
): string {
  const named = moves
    .map(
      (m) =>
        `${categoryLabel(m.category)} came to ${formatINR(m.amount)} against a usual ` +
        `${formatINR(m.baseline)}`,
    )
    .join(', and ');

  const window = windows.map((w) => w.description).join(', and with ');
  const when = `${monthName(month)} ${month.slice(0, 4)}`;

  return (
    `In ${when}, ${named} — ${formatINR(totalAbove)} more than your own six-month ` +
    `median across those categories. ${when} overlaps ${window}.`
  );
}

/** `GIFTS_DONATIONS` reads badly mid-sentence; a few categories need help. */
const CATEGORY_LABELS: Record<string, string> = {
  GIFTS_DONATIONS: 'gifts and donations',
  HEALTH_FITNESS: 'health and fitness',
  FEES_INTEREST: 'fees and interest',
};

const categoryLabel = (category: string): string =>
  CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ').toLowerCase();

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const monthName = (month: string): string => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
