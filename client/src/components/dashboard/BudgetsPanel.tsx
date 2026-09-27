import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { BudgetBar } from '@/components/BudgetBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/context/auth-context';
import { fetchBudgets } from '@/lib/budgets';

/** How many budgets the dashboard shows before pointing at the full page. */
const SHOWN = 4;

/**
 * The month's budgets, most at risk first — the alert half of "budgets and
 * alerts". A budget past its limit or within 20% of it is what a person might
 * change their week over, so it sits on the dashboard rather than behind a
 * link.
 *
 * Budgets are account-wide limits, so this ignores the dashboard's account
 * filter; it follows the month.
 */
export function BudgetsPanel({ month }: { month?: string }) {
  const { isDemo } = useAuth();
  const budgets = useQuery({
    queryKey: ['budgets', month ?? 'current'],
    queryFn: () => fetchBudgets(month),
  });

  const data = budgets.data;
  // Loading and failure are quiet here: the panel is a summary of another
  // page, and a dashboard full of spinners for secondary cards reads as broken.
  if (!data) return null;

  if (data.budgets.length === 0) {
    if (isDemo) return null;
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Budgets</CardTitle>
            <CardDescription>
              Set a monthly limit for a category, and this is where you will see it filling up.
            </CardDescription>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/budgets">Set a budget</Link>
          </Button>
        </CardHeader>
      </Card>
    );
  }

  const { over, warning } = data.totals;
  const summary =
    over + warning === 0
      ? 'Every budget is on track.'
      : [over ? `${over} over budget` : null, warning ? `${warning} nearly there` : null]
          .filter(Boolean)
          .join(', ') + '.';

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Budgets</CardTitle>
          <CardDescription role={over ? 'alert' : undefined}>{summary}</CardDescription>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link to="/budgets">All budgets</Link>
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        {data.budgets.slice(0, SHOWN).map((budget) => (
          <BudgetBar key={budget.category} budget={budget} monthElapsed={data.monthElapsed} />
        ))}
      </CardContent>
    </Card>
  );
}
