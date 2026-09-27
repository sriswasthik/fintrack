import { useMemo } from 'react';

import { toSlices } from '@/components/dashboard/slices';
import type { CategoryTotal } from '@/lib/dashboard';
import type { Category } from '@/lib/transactions';
import { formatINRCompact } from '@/lib/currency';

/**
 * Where the month's spending went, as a ranked list of bars.
 *
 * Magnitude across named categories is a length comparison, which bars make
 * exact and a donut's arcs do not. One series, so one ink: the length carries
 * the amount, the label carries the identity, and both are printed beside the
 * bar — nothing rests on colour. Every row opens the transactions behind it.
 */
export function CategoryBars({
  byCategory,
  onSelect,
}: {
  byCategory: CategoryTotal[];
  onSelect?: (category: Category) => void;
}) {
  const rows = useMemo(() => toSlices(byCategory), [byCategory]);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  // Scaled to the largest row rather than to the total, so the ranking uses
  // the full width instead of crowding into the left third.
  const largest = rows[0]?.amount ?? 0;

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground flex h-48 items-center justify-center text-sm">
        No spending in this period.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 border-b pb-3">
        <span className="eyebrow">Spent</span>
        <span className="text-xl font-medium tracking-tight tabular-nums">
          {formatINRCompact(total)}
        </span>
      </div>

      <ul className="space-y-0.5">
        {rows.map((row) => {
          const selectable = Boolean(onSelect) && row.category !== 'OTHER';
          return (
            <li key={row.category}>
              <button
                type="button"
                disabled={!selectable}
                onClick={() => selectable && onSelect!(row.category as Category)}
                title={
                  row.members
                    ? row.members.map((m) => m.replace(/_/g, ' ')).join(', ')
                    : `${row.label}: ${formatINRCompact(row.amount)} (${row.share}%)`
                }
                aria-label={
                  selectable
                    ? `${row.label}, ${formatINRCompact(row.amount)}, ${row.share}% — show transactions`
                    : undefined
                }
                className="group hover:bg-accent/50 grid w-full grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-x-3 rounded-sm px-1.5 py-1.5 text-left disabled:cursor-default disabled:hover:bg-transparent sm:grid-cols-[minmax(0,9rem)_1fr_auto]"
              >
                <span className="truncate text-[13px]">{row.label}</span>
                <span className="relative h-2" aria-hidden>
                  <span
                    className={
                      row.category === 'OTHER'
                        ? 'bg-muted-foreground/45 absolute inset-y-0 left-0 rounded-r-[4px]'
                        : 'bg-chart-1 group-hover:bg-foreground absolute inset-y-0 left-0 rounded-r-[4px] transition-colors'
                    }
                    style={{ width: `${Math.max((row.amount / largest) * 100, 1.5)}%` }}
                  />
                </span>
                <span className="text-right text-[13px] tabular-nums">
                  {formatINRCompact(row.amount)}
                  <span className="text-muted-foreground ml-2 inline-block w-11">{row.share}%</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
