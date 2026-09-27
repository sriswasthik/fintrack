import { Amount } from '@/components/Amount';
import { cn } from '@/lib/utils';
import { formatINR } from '@/lib/currency';
import { asPercent, type SavingsRate as Rate } from '@/lib/india';

/**
 * The headline number of Phase 19: what share of the month's income was kept.
 *
 * Given the hero treatment because it is the one figure on this page that
 * answers "how am I doing" in a single number — every other tile answers "what
 * happened".
 *
 * Deliberately not colour-coded against a target. There is no universal right
 * savings rate, and a red badge for 8% would be the app passing judgement on
 * somebody's month rather than reporting it. The colour tracks the *sign* only,
 * which is a fact: a negative rate means more went out than came in.
 */
export function SavingsRate({ savings, className }: { savings: Rate; className?: string }) {
  const { rate, income, expense, saved } = savings;
  const negative = rate !== null && rate < 0;

  return (
    <div className={cn('bg-card flex flex-col gap-1.5 rounded-md border p-4 sm:p-5', className)}>
      <span className="eyebrow">Savings rate</span>

      <span
        className={cn(
          'text-[1.5rem] leading-tight font-medium tracking-tight tabular-nums sm:text-[1.875rem]',
          negative && 'text-negative',
        )}
      >
        {asPercent(rate)}
      </span>

      {rate === null ? (
        // Not "0%". A month with no income does not have a savings rate, and
        // showing zero would read as "you saved nothing".
        <span className="text-muted-foreground text-xs">No income recorded this month yet</span>
      ) : negative ? (
        // "Kept −₹13,565" is not a sentence anybody means. When the month ran a
        // deficit the honest phrasing is the direction it ran in.
        <span className="text-muted-foreground text-xs">
          <Amount value={-saved} className="text-xs" /> more went out than came in
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">
          kept <Amount value={-saved} className="text-xs" /> of{' '}
          <span className="tabular-nums">{formatINR(income)}</span>
        </span>
      )}

      {rate !== null && (
        <span className="text-muted-foreground text-xs">
          <span className="tabular-nums">{asPercent(1 - rate)}</span> spent ·{' '}
          <Amount value={expense} className="text-xs" />
        </span>
      )}
    </div>
  );
}
