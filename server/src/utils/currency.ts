/**
 * Indian currency formatting.
 *
 * Deliberately hand-rolled rather than delegating to
 * `Intl.NumberFormat('en-IN', …)`. The server has to produce byte-identical
 * strings — an anomaly explanation is written once and stored, and the monthly
 * summary is validated by checking the model copied our figures exactly — so
 * "whatever ICU on this machine does" is not good enough. The grouping rule is
 * four lines and testable; the locale database is neither.
 *
 * This file is duplicated verbatim at `client/src/lib/currency.ts`. Two
 * copies of twenty lines beats a shared package in a two-workspace repo, but
 * they must stay identical: `currency.test.ts` in both workspaces runs the same
 * table of cases against each copy.
 */

/**
 * Indian digit grouping: the last three digits, then twos.
 *
 * 1234567 becomes 12,34,567 — twelve lakh, not one million two hundred
 * thousand, and the comma positions are what carry that reading.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

export interface FormatOptions {
  /** Prefix a positive amount with `+`. A negative one always shows `-`. */
  showSign?: boolean;
}

/**
 * Formats an amount in **rupees** (not paise) as `₹12,34,567.89`.
 *
 * Always two decimal places: a column of amounts that sometimes has paise and
 * sometimes does not will not line up, and money that silently loses its
 * fractional part reads as a rounding bug.
 */
export function formatINR(amount: number, opts: FormatOptions = {}): string {
  if (!Number.isFinite(amount)) return '₹0.00';

  // Round before deciding the sign, so an amount that rounds away to nothing
  // is "₹0.00" rather than a disconcerting "-₹0.00".
  const fixed = Math.abs(amount).toFixed(2);
  const zero = Number(fixed) === 0;

  const [whole, fraction] = fixed.split('.');
  const sign = zero ? '' : amount < 0 ? '-' : opts.showSign ? '+' : '';

  return `${sign}₹${groupIndian(whole)}.${fraction}`;
}

/**
 * The same amount with the paise dropped, for places where the exact figure is
 * not the point and the space is: chart axes, donut centres, tile subtitles.
 */
export function formatINRCompact(amount: number): string {
  if (!Number.isFinite(amount)) return '₹0';
  const whole = Math.round(Math.abs(amount)).toString();
  const zero = whole === '0';
  return `${zero ? '' : amount < 0 ? '-' : ''}₹${groupIndian(whole)}`;
}
