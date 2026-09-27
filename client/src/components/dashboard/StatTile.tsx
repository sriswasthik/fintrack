import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A row of headline figures on one ruled sheet — the top of a ledger page —
 * rather than a row of separate boxes. The 1px gap over a border-coloured
 * background is what draws the hairlines between the figures.
 */
export function StatSheet({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        'bg-border grid grid-cols-2 gap-px overflow-hidden rounded-md border lg:grid-cols-4',
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * A headline number with its change against the previous period.
 *
 * A single value is a stat tile, not a one-bar chart — the number *is* the
 * visualization, so it gets the hero treatment and no plot.
 */
export function StatTile({
  label,
  value,
  delta,
  /** Whether a rise is a good thing. Spending up is bad; income up is good. */
  riseIsGood = false,
  hint,
}: {
  label: string;
  value: string;
  delta?: number | null;
  riseIsGood?: boolean;
  hint?: ReactNode;
}) {
  // undefined means this metric has no comparison at all (net, counts);
  // null means it has one but the previous period was zero.
  const comparable = delta !== undefined;
  const hasDelta = comparable && delta !== null;
  const rising = hasDelta && delta > 0;
  const flat = hasDelta && delta === 0;
  const good = rising === riseIsGood;

  return (
    <div className="bg-card flex min-w-0 flex-col gap-1.5 p-4 sm:p-5">
      <span className="eyebrow">{label}</span>
      <span className="truncate text-[1.5rem] leading-tight font-medium tracking-tight tabular-nums sm:text-[1.875rem]">
        {value}
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
        {hasDelta ? (
          <span
            className={cn(
              'font-medium tabular-nums',
              flat ? 'text-muted-foreground' : good ? 'text-positive' : 'text-negative',
            )}
          >
            {/* An arrow as well as colour: the direction never rests on hue alone. */}
            {flat ? '→' : rising ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}%
          </span>
        ) : comparable ? (
          <span className="text-muted-foreground">no prior period</span>
        ) : null}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}
