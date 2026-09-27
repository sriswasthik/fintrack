import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/context/auth-context';
import { formatINR } from '@/lib/currency';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  fetchSummary,
  regenerateSummary,
  type MonthlyStats,
  type MonthlySummary,
} from '@/lib/summary';
import { errorMessage } from '@/lib/errors';

const signedPercent = (n: number) => `${n > 0 ? '+' : ''}${n}%`;

function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/**
 * The figures the paragraph is written from, laid out so a reader can check the
 * prose against them without leaving the page.
 *
 * This is the whole reason the feature is trustworthy: the summary claims
 * numbers, and the numbers are right here. The server enforces the same thing
 * mechanically before the text is ever returned.
 */
function FiguresBehindIt({ stats }: { stats: MonthlyStats }) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>The figures behind it</CardTitle>
        <CardDescription>
          Every number in the recap comes from this table — the server rejects any that does not.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {[
            { label: 'Spend', value: formatINR(stats.spend), change: stats.spendChange },
            { label: 'Income', value: formatINR(stats.income), change: stats.incomeChange },
            { label: 'Net', value: formatINR(stats.net) },
            {
              label: 'Savings rate',
              value: stats.savingsRate === null ? '—' : `${stats.savingsRate}%`,
            },
          ].map((figure) => (
            <div key={figure.label} className="space-y-0.5">
              <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {figure.label}
              </dt>
              <dd className="text-lg font-semibold tabular-nums">{figure.value}</dd>
              {figure.change !== undefined && figure.change !== null && (
                <dd className="text-muted-foreground text-xs tabular-nums">
                  {signedPercent(figure.change)} vs {stats.previousMonthLabel}
                </dd>
              )}
            </div>
          ))}
        </dl>

        {stats.topCategories.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Top categories</TableHead>
                <TableHead className="text-right">This month</TableHead>
                <TableHead className="text-right">{stats.previousMonthLabel}</TableHead>
                <TableHead className="text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.topCategories.map((row) => (
                <TableRow key={row.category}>
                  <TableCell>{row.category.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(row.amount)}</TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatINR(row.previousAmount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.change === null ? '—' : signedPercent(row.change)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {stats.topMerchant && (
          <p className="text-muted-foreground text-sm">
            Most at one merchant: {stats.topMerchant.merchant},{' '}
            <span className="tabular-nums">{formatINR(stats.topMerchant.amount)}</span> across{' '}
            {stats.topMerchant.transactions}{' '}
            {stats.topMerchant.transactions === 1 ? 'transaction' : 'transactions'}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Where the text came from, said plainly rather than implied. */
function describeProvenance(summary: MonthlySummary): string {
  const count = summary.stats.transactions;
  const from = `${count} ${count === 1 ? 'transaction' : 'transactions'}`;
  if (summary.source === 'fallback') return `Computed from ${from}`;
  const written = new Date(summary.generatedAt).toLocaleDateString('en-US', {
    dateStyle: 'medium',
  });
  return `Written ${written} from ${from}`;
}

/** A one-line note above the recap: stale figures, a fallback, an error. */
function Notice({ summary }: { summary: MonthlySummary }) {
  if (summary.unavailable) {
    return (
      <p role="status" className="text-muted-foreground bg-muted rounded-md p-3 text-sm">
        These are the month's figures rather than a written recap — {summary.unavailable}
      </p>
    );
  }
  if (summary.stale) {
    return (
      <p role="status" className="text-muted-foreground bg-muted rounded-md p-3 text-sm">
        The figures have changed since this was written. Regenerate to bring it up to date.
      </p>
    );
  }
  if (summary.source === 'fallback') {
    return (
      <p role="status" className="text-muted-foreground bg-muted rounded-md p-3 text-sm">
        The written recap did not match the computed figures, so the figures are shown instead.
      </p>
    );
  }
  return null;
}

export function SummaryPage() {
  const [params, setParams] = useSearchParams();
  const { isDemo } = useAuth();
  const [regenerateError, setRegenerateError] = useState<unknown>(null);
  const queryClient = useQueryClient();

  const month = params.get('month') ?? thisMonth();
  const key = ['summary', month];

  const summary = useQuery({ queryKey: key, queryFn: () => fetchSummary({ month }) });

  const regenerate = useMutation({
    mutationFn: () => regenerateSummary({ month }),
    onSuccess: (fresh) => {
      setRegenerateError(null);
      queryClient.setQueryData(key, fresh);
    },
    onError: setRegenerateError,
  });

  const step = (by: number) => {
    setParams({ month: shiftMonth(month, by) });
    setRegenerateError(null);
  };

  const data = summary.data;

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4 sm:gap-6 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Monthly summary</h1>
          <p className="text-muted-foreground text-sm">{monthLabel(month)}</p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            aria-label="Previous month"
            onClick={() => step(-1)}
          >
            ‹
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="Next month"
            disabled={month >= thisMonth()}
            onClick={() => step(1)}
          >
            ›
          </Button>
          {/* Regenerating writes, and costs a model call. The demo account is
              shared, so its summaries are written once at deploy time. */}
          {!isDemo && (
            <Button
              variant="outline"
              disabled={regenerate.isPending || summary.isPending}
              onClick={() => regenerate.mutate()}
            >
              {regenerate.isPending ? 'Writing…' : 'Regenerate'}
            </Button>
          )}
        </div>
      </header>

      {summary.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(summary.error)}
        </p>
      )}
      {regenerateError !== null && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(regenerateError)}
        </p>
      )}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{data ? data.stats.monthLabel : monthLabel(month)}</CardTitle>
          <CardDescription>
            {summary.isPending ? 'Reading the month…' : data ? describeProvenance(data) : ' '}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data && <Notice summary={data} />}
          <p className="max-w-prose text-[0.95rem] leading-relaxed whitespace-pre-line">
            {summary.isPending ? '' : (data?.content ?? '')}
          </p>
        </CardContent>
      </Card>

      {data && <FiguresBehindIt stats={data.stats} />}
    </main>
  );
}

export default SummaryPage;
