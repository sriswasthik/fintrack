import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { toSlices, type DonutSlice } from '@/components/dashboard/slices';
import type { CategoryTotal } from '@/lib/dashboard';
import type { Category } from '@/lib/transactions';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * Part-to-whole at a glance.
 *
 * A donut only works for a handful of segments — past about six, adjacent arcs
 * blur and the reader cannot compare them. The taxonomy has twenty categories,
 * so the top five carry their own colour and everything else folds into a single
 * "Other" slice. The category table beside this chart is where the full, precise
 * breakdown lives; the donut is the shape, the table is the numbers.
 */
/**
 * Part-to-whole at a glance.
 *
 * A donut only works for a handful of segments — past about six, adjacent arcs
 * blur and the reader cannot compare them. The taxonomy has twenty categories,
 * so the top five carry their own colour and everything else folds into a single
 * "Other" slice. The category table beside this chart is where the full,
 * precise breakdown lives; the donut is the shape, the table is the numbers.
 */
export function CategoryDonut({
  byCategory,
  onSelect,
}: {
  byCategory: CategoryTotal[];
  onSelect?: (category: Category) => void;
}) {
  const slices = useMemo(() => toSlices(byCategory), [byCategory]);
  const total = slices.reduce((sum, s) => sum + s.amount, 0);

  if (slices.length === 0) {
    return (
      <p className="text-muted-foreground flex h-64 items-center justify-center text-sm">
        No spending in this period.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-52 w-full max-w-[15rem] shrink-0 sm:h-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="amount"
              nameKey="label"
              innerRadius="62%"
              outerRadius="92%"
              // A 2px gap of surface between segments: adjacent fills never touch.
              paddingAngle={1.5}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.category} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const slice = payload[0].payload as DonutSlice;
                return (
                  <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
                    <div className="font-medium">{slice.label}</div>
                    <div className="text-muted-foreground tabular-nums">
                      {money(slice.amount)} · {slice.share}%
                    </div>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* The hero figure sits in the hole rather than as a floating label. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Spend</span>
          <span className="text-xl font-semibold tabular-nums">{money(total)}</span>
        </div>
      </div>

      {/* Legend doubling as direct labels: identity never rests on colour alone,
          which is what the sub-3:1 light-mode slots require. */}
      <ul className="w-full min-w-0 space-y-1">
        {slices.map((slice) => (
          <li key={slice.category}>
            <button
              type="button"
              disabled={!onSelect || slice.category === 'OTHER'}
              onClick={() => onSelect && slice.category !== 'OTHER' && onSelect(slice.category)}
              title={slice.members ? slice.members.join(', ') : undefined}
              className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: slice.color }}
              />
              <span className="min-w-0 flex-1 truncate">{slice.label}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {money(slice.amount)}
              </span>
              <span className="text-muted-foreground w-11 shrink-0 text-right tabular-nums">
                {slice.share}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
