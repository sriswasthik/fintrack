import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { BudgetsPanel } from '@/components/dashboard/BudgetsPanel';
import { CategoryBars } from '@/components/dashboard/CategoryBars';
import { CategoryDrilldown } from '@/components/dashboard/CategoryDrilldown';
import { CommitmentsPanel } from '@/components/dashboard/CommitmentsPanel';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import { SavingsRate } from '@/components/dashboard/SavingsRate';
import { RangeTotals } from '@/components/RangeTotals';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { SpendOverTime } from '@/components/dashboard/SpendOverTime';
import { StatSheet, StatTile } from '@/components/dashboard/StatTile';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchDashboard, type Granularity } from '@/lib/dashboard';
import { fetchIndiaInsights } from '@/lib/india';
import { CATEGORIES, fetchAccounts, type Category } from '@/lib/transactions';
import { formatINR, formatINRCompact } from '@/lib/currency';

/** "1 Jun – 30 Jun 2026": how a statement heads its period. */
function rangeLabel(from: string, to: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  return `${fmt(from, false)} – ${fmt(to, true)}`;
}

function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function DashboardPage() {
  const [month, setMonth] = useState<string | undefined>();
  const [accountId, setAccountId] = useState('all');
  const [category, setCategory] = useState('all');
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [drilldown, setDrilldown] = useState<Category | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const params = {
    ...(month ? { month } : {}),
    ...(accountId === 'all' ? {} : { accountId }),
    ...(category === 'all' ? {} : { categories: [category as Category] }),
    granularity,
  };
  // Every filter is part of the key, so a change refetches through React Query
  // rather than reloading the page.
  const dashboard = useQuery({
    queryKey: ['dashboard', params],
    queryFn: () => fetchDashboard(params),
  });

  const data = dashboard.data;
  const months = data?.availableMonths ?? [];
  const currentMonth = data?.range.month ?? month ?? null;
  const monthIndex = currentMonth ? months.indexOf(currentMonth) : -1;

  // Phase 19's five statistics-only features, on their own query so a slow or
  // failed India pass never holds up the dashboard itself — the page is useful
  // without it, and every part of it renders only once its data arrives. Keyed
  // off the month the dashboard actually resolved, so the two never disagree
  // about which month is on screen.
  const indiaParams = {
    ...(currentMonth ? { month: currentMonth } : {}),
    ...(accountId === 'all' ? {} : { accountId }),
  };
  const india = useQuery({
    queryKey: ['india', indiaParams],
    queryFn: () => fetchIndiaInsights(indiaParams),
    enabled: currentMonth !== null,
  });

  const step = (by: number) => {
    const next = months[monthIndex + by];
    if (next) setMonth(next);
  };

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:gap-6 sm:p-6">
      {/* Headed like a statement: the period is the title, the page is the label. */}
      <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="eyebrow">Dashboard</p>
          <h1 className="font-display text-[2.25rem] leading-none font-semibold tracking-tight sm:text-[2.75rem]">
            {currentMonth ? monthLabel(currentMonth) : 'Your month'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {data
              ? `${rangeLabel(data.range.from, data.range.to)} · ${data.totals.transactions} transaction${data.totals.transactions === 1 ? '' : 's'}`
              : 'Loading…'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            aria-label="Previous month"
            disabled={monthIndex <= 0}
            onClick={() => step(-1)}
          >
            ‹
          </Button>
          <Select value={currentMonth ?? ''} onValueChange={setMonth}>
            <SelectTrigger aria-label="Month" className="w-44">
              <SelectValue placeholder="Month" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="outline"
            aria-label="Next month"
            disabled={monthIndex < 0 || monthIndex >= months.length - 1}
            onClick={() => step(1)}
          >
            ›
          </Button>
        </div>
      </header>

      {/* Filters live in one row above the charts, never interleaved with them. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger aria-label="Account" className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {(accounts.data ?? []).map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger aria-label="Category" className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(accountId !== 'all' || category !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAccountId('all');
              setCategory('all');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {dashboard.isError && (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      )}

      {dashboard.isPending && <Loading label="Adding up your month…" />}

      {data && data.totals.transactions === 0 && (
        <EmptyState
          title="Nothing in this month"
          description={
            months.length === 0
              ? 'Import a bank export and this is where the numbers land.'
              : 'Try another month, or clear the filters above.'
          }
          action={
            months.length === 0 ? (
              <Button asChild size="sm">
                <Link to="/upload">Import a statement</Link>
              </Button>
            ) : undefined
          }
        />
      )}

      {data && data.totals.transactions > 0 && (
        <>
          <StatSheet>
            <StatTile
              label="Spent"
              value={data ? formatINR(data.totals.spend) : '—'}
              delta={data?.deltas.spend}
              hint={data ? `vs ${formatINRCompact(data.previous.spend)}` : undefined}
            />
            <StatTile
              label="Received"
              value={data ? formatINR(data.totals.income) : '—'}
              delta={data?.deltas.income}
              riseIsGood
              hint={
                data ? (
                  <>
                    vs {formatINRCompact(data.previous.income)}
                    {(data.totals.unreviewedIn ?? 0) > 0 && (
                      <>
                        {' · '}
                        <Link
                          to="/review"
                          className="text-foreground underline underline-offset-2"
                          title="Money in that has not been categorized yet. It counts as neither spending nor income until it is."
                        >
                          {formatINRCompact(data.totals.unreviewedIn ?? 0)} to review
                        </Link>
                      </>
                    )}
                  </>
                ) : undefined
              }
            />
            <StatTile
              label="Net"
              value={data ? formatINR(data.totals.net) : '—'}
              hint="income minus spend"
            />
            <StatTile
              label="Transactions"
              value={data ? String(data.totals.transactions) : '—'}
              hint={data ? `${data.previous.transactions} last period` : undefined}
            />
          </StatSheet>

          {/* The one figure on this page that answers "how am I doing" rather
              than "what happened", so it gets a row of its own rather than a
              fifth slot in the grid above. */}
          {india.data && (
            <section className="grid gap-3 sm:gap-4 lg:grid-cols-3">
              <SavingsRate savings={india.data.savings} />
              <div className="lg:col-span-2">
                <CommitmentsPanel insights={india.data} />
              </div>
            </section>
          )}

          {/* Above the charts: an unexpected charge is the one thing on this page a
          person might need to act on today. */}
          <InsightsPanel
            month={currentMonth ?? undefined}
            accountId={accountId === 'all' ? undefined : accountId}
            india={india.data}
          />

          <section className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <CardTitle>Spend over time</CardTitle>
                  <CardDescription>
                    {data ? rangeLabel(data.range.from, data.range.to) : ' '}
                  </CardDescription>
                </div>
                <Tabs value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
                  <TabsList>
                    <TabsTrigger value="daily">Daily</TabsTrigger>
                    <TabsTrigger value="weekly">Weekly</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent>
                {data && (
                  <SpendOverTime series={data.series} granularity={data.range.granularity} />
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Where it went</CardTitle>
                <CardDescription>
                  Transfers excluded; refunds netted against what they returned. Select a row for
                  its transactions.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data && <CategoryBars byCategory={data.byCategory} onSelect={setDrilldown} />}
              </CardContent>
            </Card>
          </section>

          {/* Budgets follow the month, not the account filter: a limit is on
              the household's spending in a category, wherever it was paid from. */}
          <BudgetsPanel month={currentMonth ?? undefined} />

          {/* Its own range, deliberately: the tiles above answer "this month",
          and the question this one exists for is "what about today / the
          quarter / those three weeks in June". It follows the account filter
          because that is a filter on whose money, not on which window. */}
          <RangeTotals
            accountId={accountId === 'all' ? undefined : accountId}
            title="Debits and credits"
          />

          <section className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Top merchants</CardTitle>
                <CardDescription>By spend in this period</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Merchant</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Txns</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.topMerchants ?? []).map((merchant) => (
                      <TableRow key={merchant.merchant}>
                        <TableCell className="max-w-[14rem] truncate">
                          {merchant.merchant}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatINR(merchant.amount)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right tabular-nums">
                          {merchant.transactions}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* The table view behind the bars: every category, at full precision,
            not just the seven the bar list names. */}
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>By category</CardTitle>
                <CardDescription>Select a row to see the transactions behind it</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                      <TableHead className="text-right">Txns</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.byCategory ?? []).map((row) => (
                      <TableRow
                        key={row.category}
                        className="cursor-pointer"
                        onClick={() => setDrilldown(row.category)}
                      >
                        <TableCell>
                          <button
                            type="button"
                            className="hover:underline"
                            aria-label={`Show ${row.category} transactions`}
                          >
                            {row.category.replace(/_/g, ' ')}
                          </button>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatINR(row.amount)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right tabular-nums">
                          {row.share > 0 ? `${row.share}%` : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right tabular-nums">
                          {row.transactions}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>
        </>
      )}

      <CategoryDrilldown
        category={drilldown}
        month={currentMonth}
        accountId={accountId === 'all' ? undefined : accountId}
        onOpenChange={(open) => !open && setDrilldown(null)}
      />
    </main>
  );
}

export default DashboardPage;
