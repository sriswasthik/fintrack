import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Amount } from '@/components/Amount';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  fetchTotals,
  isoDate,
  isoMonth,
  quarterRange,
  type RangeTotals as Totals,
  type TotalsParams,
} from '@/lib/totals';

/**
 * Debits, credits and net over a window the reader chooses.
 *
 * Standalone on purpose: it holds its own range, runs its own query and takes
 * nothing from the page around it but an optional account filter, so it drops
 * onto the dashboard, a payee screen or a page that does not exist yet without
 * any of them having to know how a quarter is worked out.
 *
 * "This Quarter" is resolved here rather than server-side. A quarter is just a
 * custom range with a name, and the server having its own idea of which one you
 * are in is a second calendar to keep in step with this one.
 */

type Preset = 'today' | 'month' | 'quarter' | 'custom';

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'custom', label: 'Custom' },
];

export interface RangeTotalsProps {
  /** Narrows to one account. Omit for every account the user has. */
  accountId?: string;
  /** Which chip starts selected. */
  defaultPreset?: Preset;
  title?: string;
  className?: string;
}

/** The query the chosen preset asks for. */
function paramsFor(
  preset: Preset,
  custom: { startDate: string; endDate: string },
  today: Date,
): TotalsParams {
  switch (preset) {
    case 'today':
      return { range: 'daily', date: isoDate(today) };
    case 'month':
      return { range: 'monthly', month: isoMonth(today) };
    case 'quarter':
      return { range: 'custom', ...quarterRange(today) };
    case 'custom':
      return { range: 'custom', ...custom };
  }
}

/** How the window reads under the heading, once the server has confirmed it. */
function describe(range: Totals['range']): string {
  if (range.kind === 'daily') return range.startDate;
  if (range.startDate === range.endDate) return range.startDate;
  return `${range.startDate} → ${range.endDate}`;
}

function Figure({
  label,
  value,
  direction,
  hint,
}: {
  label: string;
  value: number;
  direction?: 'debit' | 'credit';
  hint?: string;
}) {
  return (
    <div className="bg-card rounded-md border p-3">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <Amount
        value={value}
        direction={direction}
        className="text-lg font-medium tracking-tight sm:text-xl"
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function RangeTotals({
  accountId,
  defaultPreset = 'month',
  title = 'Totals',
  className,
}: RangeTotalsProps) {
  // Read once per mount. Re-reading the clock on every render would make the
  // query key change under a component that is only sitting there.
  const today = useMemo(() => new Date(), []);
  const [preset, setPreset] = useState<Preset>(defaultPreset);
  const [custom, setCustom] = useState(() => quarterRange(today));

  const params = { ...paramsFor(preset, custom, today), ...(accountId ? { accountId } : {}) };
  // A half-filled custom range is not a question the server can answer, so it
  // is not asked — the previous answer stays on screen while they finish typing.
  const complete = preset !== 'custom' || Boolean(custom.startDate && custom.endDate);
  const backwards = preset === 'custom' && complete && custom.endDate < custom.startDate;

  const query = useQuery({
    queryKey: ['totals', params],
    queryFn: () => fetchTotals(params),
    enabled: complete && !backwards,
  });

  const data = query.data;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {data
            ? `${describe(data.range)} · ${data.transactionCount} transaction${data.transactionCount === 1 ? '' : 's'}`
            : 'Money in and out over a window you choose.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Range">
          {PRESETS.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={preset === value ? 'default' : 'outline'}
              aria-pressed={preset === value}
              onClick={() => setPreset(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">From</span>
              <Input
                type="date"
                className="w-auto"
                value={custom.startDate}
                max={custom.endDate || undefined}
                onChange={(event) =>
                  setCustom((current) => ({ ...current, startDate: event.target.value }))
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">To</span>
              <Input
                type="date"
                className="w-auto"
                value={custom.endDate}
                min={custom.startDate || undefined}
                onChange={(event) =>
                  setCustom((current) => ({ ...current, endDate: event.target.value }))
                }
              />
            </label>
          </div>
        )}

        {backwards && (
          <p className="text-destructive text-sm">The end date is before the start date.</p>
        )}

        {query.isError && (
          <ErrorState error={query.error} fallback="Could not add up that range." />
        )}

        <div
          className={cn(
            'grid grid-cols-1 gap-3 sm:grid-cols-3',
            // Dimmed rather than replaced by a spinner: the previous figures
            // stay readable and nothing jumps while the next range loads.
            query.isFetching && 'opacity-60',
          )}
          aria-busy={query.isFetching}
        >
          <Figure
            label="Debits"
            value={data?.totalDebits ?? 0}
            direction="debit"
            hint="money out"
          />
          <Figure
            label="Credits"
            value={data?.totalCredits ?? 0}
            direction="credit"
            hint="money in"
          />
          {/* No forced direction: net is debit-positive like every stored
              amount, so its own sign is the answer. */}
          <Figure
            label="Net"
            value={data?.net ?? 0}
            hint={
              !data || data.net === 0
                ? 'debits minus credits'
                : data.net > 0
                  ? 'more left than arrived'
                  : 'more arrived than left'
            }
          />
        </div>

        {data && data.transactionCount === 0 && (
          <p className="text-muted-foreground text-sm">Nothing in this range.</p>
        )}
      </CardContent>
    </Card>
  );
}
