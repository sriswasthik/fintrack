import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Granularity, SeriesPoint } from '@/lib/dashboard';
import { formatINRCompact } from '@/lib/currency';

/**
 * Spend over time — one series, so it takes the sequential hue rather than a
 * categorical slot, and needs no legend: the card title names it.
 *
 * Area rather than line because a single series over time reads as accumulation,
 * and the fill gives the eye the shape of the month at a glance.
 */

function formatBucket(iso: string, granularity: Granularity): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return granularity === 'weekly' ? `w/c ${day}` : day;
}

export function SpendOverTime({
  series,
  granularity,
}: {
  series: SeriesPoint[];
  granularity: Granularity;
}) {
  if (series.length === 0) {
    return (
      <p className="text-muted-foreground flex h-64 items-center justify-center text-sm">
        No spending in this period.
      </p>
    );
  }

  return (
    <div className="h-56 w-full sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {/* Recessive chrome: horizontal hairlines only, no vertical rules. */}
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => formatBucket(value, granularity)}
            stroke="var(--chart-axis)"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(value: number) => formatINRCompact(value)}
            stroke="var(--chart-axis)"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
                  <div className="font-medium">{formatBucket(String(label), granularity)}</div>
                  <div className="text-muted-foreground tabular-nums">
                    {formatINRCompact(Number(payload[0].value))}
                  </div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="spend"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#spendFill)"
            // Points appear on hover rather than crowding every bucket.
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
