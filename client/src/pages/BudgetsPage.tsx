import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { BudgetBar } from '@/components/BudgetBar';
import { StatSheet, StatTile } from '@/components/dashboard/StatTile';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/context/auth-context';
import {
  BUDGETABLE_CATEGORIES,
  fetchBudgets,
  isoMonth,
  removeBudget,
  saveBudget,
  shiftMonth,
  type BudgetProgress,
} from '@/lib/budgets';
import { formatINR } from '@/lib/currency';
import { errorMessage } from '@/lib/errors';
import type { Category } from '@/lib/transactions';

function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(year, index - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Monthly budgets per category.
 *
 * The limits are the person's; what has been spent against them comes from
 * the same aggregation as the dashboard — transfers excluded, refunds netted —
 * so the two pages never tell them different things about one month.
 */
export function BudgetsPage() {
  const { isDemo } = useAuth();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(() => isoMonth());

  const budgets = useQuery({ queryKey: ['budgets', month], queryFn: () => fetchBudgets(month) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['budgets'] });

  const data = budgets.data;
  const taken = new Set(data?.budgets.map((b) => b.category));
  const available = BUDGETABLE_CATEGORIES.filter((c) => !taken.has(c));

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Budgets</h1>
          <p className="text-muted-foreground text-sm">
            A monthly limit per category, measured against exactly what the dashboard counts as
            spending.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label="Previous month"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ‹
          </Button>
          <span className="min-w-36 text-center text-sm font-medium" aria-live="polite">
            {monthLabel(month)}
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label="Next month"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </Button>
        </div>
      </div>

      {budgets.isPending && <Loading label="Adding up the month…" />}
      {budgets.isError && (
        <ErrorState error={budgets.error} onRetry={() => void budgets.refetch()} />
      )}

      {data && (
        <>
          <StatSheet>
            <StatTile label="Budgeted" value={formatINR(data.totals.budgeted)} />
            <StatTile label="Spent against budgets" value={formatINR(data.totals.spent)} />
            <StatTile
              label={data.totals.remaining >= 0 ? 'Left' : 'Over'}
              value={formatINR(Math.abs(data.totals.remaining))}
              hint={
                data.totals.over > 0
                  ? `${data.totals.over} categor${data.totals.over === 1 ? 'y' : 'ies'} over`
                  : undefined
              }
            />
            <StatTile
              label="Spent with no budget"
              value={formatINR(data.totals.unbudgetedSpend)}
              hint="Categories you have not set a limit for"
            />
          </StatSheet>

          <Card>
            <CardHeader>
              <CardTitle>{monthLabel(month)}</CardTitle>
              <CardDescription>
                Most at risk first.
                {data.monthElapsed > 0 &&
                  data.monthElapsed < 1 &&
                  ' The tick on each bar is where spending would be if it were spread evenly across the month.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {data.budgets.length === 0 && (
                <EmptyState
                  title="No budgets yet"
                  description={
                    isDemo
                      ? 'The sample account has no budgets, and is read-only.'
                      : 'Pick a category below and give it a monthly limit. Budgets apply to every month until you change them.'
                  }
                />
              )}
              {data.budgets.map((budget) => (
                <BudgetRow
                  key={budget.category}
                  budget={budget}
                  monthElapsed={data.monthElapsed}
                  readOnly={isDemo}
                  onChanged={refresh}
                />
              ))}
            </CardContent>
          </Card>

          {!isDemo && available.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Add a budget</CardTitle>
                <CardDescription>
                  A limit applies to every month. Income, transfers between your own accounts and
                  refunds cannot have one — they are not spending.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AddBudgetForm categories={available} onSaved={refresh} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </main>
  );
}

function AddBudgetForm({ categories, onSaved }: { categories: Category[]; onSaved: () => void }) {
  const [category, setCategory] = useState<Category>(categories[0]);
  const [amount, setAmount] = useState('');

  const mutation = useMutation({
    mutationFn: saveBudget,
    onSuccess: () => {
      setAmount('');
      onSaved();
    },
  });

  // The chosen category can be taken by the save that just happened.
  const selected = categories.includes(category) ? category : categories[0];
  const value = Number(amount);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!(value > 0)) return;
    mutation.mutate({ category: selected, amount: value });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      aria-label="Add a budget"
    >
      <div className="space-y-1.5 sm:w-64">
        <label htmlFor="budget-category" className="text-sm font-medium">
          Category
        </label>
        <Select value={selected} onValueChange={(v) => setCategory(v as Category)}>
          <SelectTrigger id="budget-category" aria-label="Budget category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 space-y-1.5">
        <label htmlFor="budget-amount" className="text-sm font-medium">
          Monthly limit (₹)
        </label>
        <Input
          id="budget-amount"
          type="number"
          inputMode="decimal"
          min="1"
          step="any"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={!(value > 0) || mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Add budget'}
      </Button>
      {mutation.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(mutation.error)}
        </p>
      )}
    </form>
  );
}

function BudgetRow({
  budget,
  monthElapsed,
  readOnly,
  onChanged,
}: {
  budget: BudgetProgress;
  monthElapsed: number;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(budget.amount));

  const save = useMutation({
    mutationFn: saveBudget,
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({ mutationFn: removeBudget, onSuccess: onChanged });

  const value = Number(amount);

  return (
    <div className="space-y-2 border-b pb-5 last:border-0 last:pb-0">
      <BudgetBar budget={budget} monthElapsed={monthElapsed} />

      {!readOnly && !editing && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Change the ${budget.category} budget`}
            onClick={() => {
              setAmount(String(budget.amount));
              setEditing(true);
            }}
          >
            Change
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            aria-label={`Remove the ${budget.category} budget`}
            disabled={remove.isPending}
            onClick={() => remove.mutate(budget.category)}
          >
            Remove
          </Button>
        </div>
      )}

      {editing && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={`Change the ${budget.category} budget`}
          onSubmit={(event) => {
            event.preventDefault();
            if (value > 0) save.mutate({ category: budget.category, amount: value });
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor={`budget-${budget.category}`} className="text-sm font-medium">
              New monthly limit (₹)
            </label>
            <Input
              id={`budget-${budget.category}`}
              type="number"
              inputMode="decimal"
              min="1"
              step="any"
              autoFocus
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-40"
            />
          </div>
          <Button type="submit" size="sm" disabled={!(value > 0) || save.isPending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}

      {(save.isError || remove.isError) && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(save.error ?? remove.error)}
        </p>
      )}
    </div>
  );
}

export default BudgetsPage;
