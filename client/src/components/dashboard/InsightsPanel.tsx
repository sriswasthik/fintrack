import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  dismissInsight,
  fetchInsights,
  type AnomalySeverity,
  type AnomalyType,
  type Insight,
  type InsightsParams,
  type InsightsResponse,
} from '@/lib/insights';

/**
 * What each kind of finding is called in front of a person. The enum names are
 * for the database; nobody wants to read SUBSCRIPTION_PRICE_INCREASE.
 */
const TYPE_LABEL: Record<AnomalyType, string> = {
  UNUSUAL_AMOUNT: 'Unusual amount',
  NEW_RECURRING_CHARGE: 'New recurring charge',
  SUBSCRIPTION_PRICE_INCREASE: 'Price increase',
  CATEGORY_SPEND_SPIKE: 'Spending spike',
  POSSIBLE_DUPLICATE: 'Possible duplicate',
};

/**
 * Severity is carried by the rail colour *and* by the word next to the type, so
 * it survives a monochrome print and a red-green colour deficiency alike.
 *
 * Orange rather than red at the top end on purpose: an anomaly is something to
 * look at, not something that has gone wrong, and a panel that shouts at you
 * about a laptop you meant to buy is one you learn to ignore.
 */
const SEVERITY: Record<AnomalySeverity, { label: string; rail: string }> = {
  HIGH: { label: 'High', rail: 'bg-[var(--chart-2)]' },
  MEDIUM: { label: 'Medium', rail: 'bg-[var(--chart-4)]' },
  LOW: { label: 'Low', rail: 'bg-[var(--chart-axis)]' },
};

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function InsightRow({ insight, onDismiss }: { insight: Insight; onDismiss: () => void }) {
  const severity = SEVERITY[insight.severity];

  return (
    <li className="flex items-stretch gap-3 py-3 first:pt-0 last:pb-0">
      <span aria-hidden className={`w-[3px] shrink-0 rounded-full ${severity.rail}`} />

      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {TYPE_LABEL[insight.type]}
          <span className="mx-1.5 opacity-40">/</span>
          <span className="normal-case">{severity.label}</span>
        </p>
        <p className="text-sm leading-snug">{insight.explanation}</p>
        {insight.transaction && (
          <p className="text-muted-foreground text-xs tabular-nums">
            {insight.transaction.date} · {insight.transaction.description} ·{' '}
            {money(insight.transaction.amount)}
          </p>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground -mt-1 shrink-0 self-start"
        aria-label={`Dismiss: ${insight.explanation}`}
        onClick={onDismiss}
      >
        ×
      </Button>
    </li>
  );
}

/**
 * The insights panel.
 *
 * Sits directly under the headline numbers, because a $3,299 charge you did not
 * expect matters more than any of the charts below it — and disappears into a
 * single quiet line when there is nothing to say, which is most months.
 */
export function InsightsPanel({ month, accountId }: InsightsParams) {
  const queryClient = useQueryClient();
  const params: InsightsParams = {
    ...(month ? { month } : {}),
    ...(accountId ? { accountId } : {}),
  };
  const key = ['insights', params];

  const insights = useQuery({ queryKey: key, queryFn: () => fetchInsights(params) });

  const dismiss = useMutation({
    mutationFn: dismissInsight,
    // Removed on click rather than after the round trip: dismissing is the one
    // interaction here, and waiting on the network to see it happen makes the
    // panel feel broken.
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InsightsResponse>(key);
      if (previous) {
        queryClient.setQueryData<InsightsResponse>(key, {
          ...previous,
          insights: previous.insights.filter((insight) => insight.id !== id),
        });
      }
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const rows = insights.data?.insights ?? [];
  const dismissed = (insights.data?.detected ?? 0) - rows.length;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Worth a look</CardTitle>
        <CardDescription>
          {insights.isPending
            ? 'Checking this month…'
            : rows.length > 0
              ? `${rows.length} thing${rows.length === 1 ? '' : 's'} stood out this month`
              : 'Nothing unusual this month.'}
        </CardDescription>
      </CardHeader>

      {(rows.length > 0 || dismiss.isError || dismissed > 0) && (
        <CardContent>
          {dismiss.isError && (
            <p role="alert" className="text-destructive mb-2 text-sm">
              That insight could not be dismissed. It is back in the list.
            </p>
          )}

          <ul className="divide-y">
            {rows.map((insight) => (
              <InsightRow
                key={insight.id}
                insight={insight}
                onDismiss={() => dismiss.mutate(insight.id)}
              />
            ))}
          </ul>

          {dismissed > 0 && (
            <p className="text-muted-foreground mt-3 text-xs">
              {dismissed} dismissed {dismissed === 1 ? 'insight' : 'insights'} hidden.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default InsightsPanel;
