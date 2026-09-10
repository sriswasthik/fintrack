import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatINR } from '@/lib/currency';
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
import {
  CATEGORIES,
  fetchReviewQueue,
  overrideCategory,
  type Category,
  type Transaction,
} from '@/lib/transactions';


function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const data = (error as { response?: { data?: { error?: string } } }).response?.data;
    if (data?.error) return data.error;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * The review queue: everything no automated pass could settle confidently.
 *
 * Two rows appear here — transactions nothing could categorize, and AI answers
 * the model itself was unsure about. The second kind carries a suggestion, so
 * the common action is one click to accept it.
 */
export function ReviewPage() {
  const queryClient = useQueryClient();
  const [lastLearned, setLastLearned] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['review-queue'],
    queryFn: () => fetchReviewQueue({ limit: 100 }),
  });

  const mutation = useMutation({
    mutationFn: overrideCategory,
    onSuccess: (result) => {
      setLastLearned(
        result.learnedRule
          ? `Learned: ${result.learnedRule.pattern} → ${result.learnedRule.category}`
          : null,
      );
      void queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const data = queue.data;
  const pendingId = mutation.isPending ? mutation.variables?.transactionId : null;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
        <p className="text-muted-foreground text-sm">
          Transactions nothing could categorize with confidence. Accepting or correcting one teaches
          a rule, so the same merchant is never asked about again.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{data ? `${data.total.toLocaleString()} to review` : 'Loading…'}</CardTitle>
          <CardDescription>
            {data
              ? `${data.counts.uncategorized} uncategorized, ${data.counts.lowConfidence} AI-suggested below ${data.lowConfidenceThreshold} confidence.`
              : ' '}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {queue.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(queue.error)}
            </p>
          )}

          {data && data.total === 0 && (
            <p className="text-muted-foreground text-sm">
              Nothing to review — every transaction has a confident category.
            </p>
          )}

          {mutation.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(mutation.error)}
            </p>
          )}

          {lastLearned && (
            <p role="status" className="text-muted-foreground text-sm">
              {lastLearned}
            </p>
          )}

          {data && data.transactions.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Suggestion</TableHead>
                  <TableHead className="w-72">Decide</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.transactions.map((transaction) => (
                  <ReviewRow
                    key={transaction.id}
                    transaction={transaction}
                    threshold={data.lowConfidenceThreshold}
                    busy={pendingId === transaction.id}
                    onDecide={(category) =>
                      mutation.mutate({ transactionId: transaction.id, category })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function ReviewRow({
  transaction,
  threshold,
  busy,
  onDecide,
}: {
  transaction: Transaction;
  threshold: number;
  busy: boolean;
  onDecide: (category: Category) => void;
}) {
  // A stored AI answer below the threshold is a suggestion worth one click.
  const suggestion =
    transaction.source === 'LLM' && transaction.category !== 'UNCATEGORIZED'
      ? transaction.category
      : null;
  const [choice, setChoice] = useState<Category>(suggestion ?? 'UNCATEGORIZED');

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">{transaction.date}</TableCell>
      <TableCell>
        <div className="font-medium">{transaction.normalizedMerchant || '—'}</div>
        <div className="text-muted-foreground max-w-[16rem] truncate font-mono text-xs">
          {transaction.description}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatINR(transaction.amount)}</TableCell>
      <TableCell>
        {suggestion ? (
          <div className="flex flex-col gap-1">
            <Badge variant="secondary">{suggestion}</Badge>
            <span
              className={
                transaction.confidence < threshold
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {(transaction.confidence * 100).toFixed(0)}% confident
            </span>
          </div>
        ) : (
          <Badge variant="outline">no suggestion</Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {suggestion && (
            <Button
              size="sm"
              disabled={busy}
              aria-label={`Accept ${suggestion} for ${transaction.normalizedMerchant}`}
              onClick={() => onDecide(suggestion)}
            >
              Accept
            </Button>
          )}
          <Select value={choice} onValueChange={(value) => setChoice(value as Category)}>
            <SelectTrigger
              aria-label={`Category for ${transaction.normalizedMerchant}`}
              className="w-44"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || choice === 'UNCATEGORIZED'}
            aria-label={`Save category for ${transaction.normalizedMerchant}`}
            onClick={() => onDecide(choice)}
          >
            Save
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default ReviewPage;
