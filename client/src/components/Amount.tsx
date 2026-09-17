import { AMOUNT_STYLE, directionOf, type AmountDirection } from '@/lib/amount';
import { cn } from '@/lib/utils';
import { formatINR, formatINRCompact } from '@/lib/currency';

/**
 * One money figure, coloured by direction.
 *
 * Every amount on a transaction goes through here, which is the point: red and
 * green is a convention, and a convention applied by hand at a dozen call sites
 * is one screen away from disagreeing with itself. Change the rule in
 * `lib/amount.ts` and every screen changes with it.
 *
 * Colour is never the only signal. Every non-zero amount carries a leading
 * sign, so the direction survives a greyscale print, a colourblind reader and a
 * screen reader — the same rule Phase 5's stat tiles already follow for their
 * deltas.
 */
export interface AmountProps {
  /**
   * The amount in rupees. Debit-positive (see `lib/amount.ts`) unless
   * `direction` is given, in which case only its magnitude is used.
   */
  value: number;
  /**
   * Forces the direction, for a figure already stored as a magnitude — a
   * payee's "received", the totals widget's two columns. Omit it for anything
   * that carries its own sign, such as a transaction amount.
   */
  direction?: AmountDirection;
  /** Drops the paise, for tight spaces. Matches `formatINRCompact`. */
  compact?: boolean;
  className?: string;
}

export function Amount({ value, direction, compact = false, className }: AmountProps) {
  // Zero is neither direction, even in a column that is always one of them: a
  // green "+₹0.00" under "Credits" claims something arrived when nothing did,
  // and it would also make the same number render two ways depending on whether
  // the call site happened to force a direction.
  const resolved = directionOf(value) === null ? null : (direction ?? directionOf(value));
  const format = compact ? formatINRCompact : formatINR;
  const formatted = format(Math.abs(value));
  const style = resolved ? AMOUNT_STYLE[resolved] : null;

  // Deliberately plain text rather than an aria-label over an aria-hidden
  // span: `aria-label` on a span with no role is not reliably announced, and
  // the sign is already in the text, where a screen reader reads it as "minus"
  // or "plus" and a sighted reader sees it. One string, everybody gets it.
  return (
    <span className={cn('tabular-nums', style?.className, className)}>
      {style?.sign}
      {formatted}
    </span>
  );
}
