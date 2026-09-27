import { BUDGET_STATUS, type BudgetProgress } from '@/lib/budgets';
import { formatINR } from '@/lib/currency';

/**
 * One budget as a bar: how much of the limit is used, and — for the month in
 * progress — a tick at where spending would be if it were spread evenly, so
 * "60% used" can be read against "50% of the month gone".
 */
export function BudgetBar({
  budget,
  monthElapsed,
}: {
  budget: BudgetProgress;
  monthElapsed?: number;
}) {
  const status = BUDGET_STATUS[budget.status];
  const width = Math.min(100, Math.max(0, budget.percent));
  const showPace = monthElapsed !== undefined && monthElapsed > 0 && monthElapsed < 1;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{budget.category}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatINR(budget.spent)} of {formatINR(budget.amount)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${budget.category} budget used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${budget.percent}% used, ${status.label.toLowerCase()}`}
        className="bg-muted relative h-2 overflow-hidden rounded-full"
      >
        <div className={`h-full rounded-full ${status.fill}`} style={{ width: `${width}%` }} />
        {showPace && (
          <span
            aria-hidden
            title="Where spending would be if spread evenly across the month"
            className="bg-foreground/60 absolute top-0 h-full w-px"
            style={{ left: `${monthElapsed * 100}%` }}
          />
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        <span className="text-foreground font-medium">{status.label}</span> ·{' '}
        {budget.remaining >= 0
          ? `${formatINR(budget.remaining)} left`
          : `${formatINR(-budget.remaining)} over`}{' '}
        · {budget.percent}%
      </p>
    </div>
  );
}
