import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { Badge } from '@/components/ui/badge';
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
import { useAuth } from '@/context/auth-context';
import { TRANSACTION_DERIVED_QUERIES } from '@/lib/accounts';
import { errorMessage } from '@/lib/errors';
import { deleteRule, fetchRules, updateRule, type LearnedRule } from '@/lib/rules';
import { CATEGORIES, type Category } from '@/lib/transactions';

/**
 * The rules FinTrack has learned from this person's corrections.
 *
 * Every accepted category on the review page teaches one. Until this page they
 * could not be seen, so a correction made by mistake kept recategorizing that
 * merchant on every import with nowhere to find out why.
 */
export function RulesPage() {
  const { isDemo } = useAuth();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: fetchRules });
  const [doomed, setDoomed] = useState<LearnedRule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A rule change re-runs the engine, which can move totals on every page.
  const refreshEverything = () => {
    for (const key of TRANSACTION_DERIVED_QUERIES) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  const change = useMutation({
    mutationFn: updateRule,
    onSuccess: (result, input) => {
      setNotice(
        `Now ${input.category}. ${result.recategorized} transaction${result.recategorized === 1 ? '' : 's'} moved.`,
      );
      refreshEverything();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: (result) => {
      setDoomed(null);
      setNotice(
        `Rule forgotten. ${result.recategorized} transaction${result.recategorized === 1 ? '' : 's'} went back to the automatic answer.`,
      );
      refreshEverything();
    },
  });

  const list = rules.data ?? [];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Learned rules</h1>
        <p className="text-muted-foreground text-sm">
          Each correction you make on the{' '}
          <Link to="/review" className="text-foreground underline underline-offset-4">
            review page
          </Link>{' '}
          teaches FinTrack how to categorize that merchant from then on. Changing a rule here moves
          the transactions it decided; the ones you corrected by hand stay as you set them.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {rules.isSuccess ? `${list.length} rule${list.length === 1 ? '' : 's'}` : 'Rules'}
          </CardTitle>
          <CardDescription>
            Built-in rules for Indian merchants are shared by everyone and are not listed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {change.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(change.error)}
            </p>
          )}

          {rules.isPending && <Loading label="Loading rules…" />}
          {rules.isError && <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />}
          {rules.isSuccess && list.length === 0 && (
            <EmptyState
              title="Nothing learned yet"
              description="When you correct a category on the review page, the rule it teaches appears here."
            />
          )}

          {list.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Merchant</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Transactions</TableHead>
                    {!isDemo && <TableHead className="w-24" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell>
                        <div className="font-medium">{rule.merchant ?? rule.pattern}</div>
                        {rule.merchant === null && (
                          <div className="text-muted-foreground font-mono text-xs">pattern</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {isDemo ? (
                          <Badge variant="secondary">{rule.category}</Badge>
                        ) : (
                          <Select
                            value={rule.category}
                            disabled={change.isPending}
                            onValueChange={(value) =>
                              change.mutate({ id: rule.id, category: value as Category })
                            }
                          >
                            <SelectTrigger
                              aria-label={`Category for ${rule.merchant ?? rule.pattern}`}
                              className="w-48"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CATEGORIES.filter((c) => c !== 'UNCATEGORIZED').map((category) => (
                                <SelectItem key={category} value={category}>
                                  {category}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {rule.transactionCount ?? '—'}
                      </TableCell>
                      {!isDemo && (
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            aria-label={`Forget the rule for ${rule.merchant ?? rule.pattern}`}
                            onClick={() => {
                              remove.reset();
                              setDoomed(rule);
                            }}
                          >
                            Forget
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={doomed !== null}
        title="Forget this rule?"
        description={
          <p>
            Future transactions from <strong>{doomed?.merchant ?? doomed?.pattern}</strong> will be
            categorized by the built-in rules again, or wait for you in the review queue. The ones
            you corrected by hand keep the category you gave them.
          </p>
        }
        confirmLabel="Forget rule"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => doomed && remove.mutate(doomed.id)}
        onCancel={() => setDoomed(null)}
      />
    </main>
  );
}

export default RulesPage;
