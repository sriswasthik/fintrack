import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

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
import { Amount } from '@/components/Amount';
import { SplitDialog } from '@/components/SplitDialog';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { errorMessage } from '@/lib/errors';
import {
  downloadTransactionsCsv,
  fetchAccounts,
  fetchTransactions,
  type Transaction,
} from '@/lib/transactions';

const PAGE_SIZE = 50;

export function TransactionsPage() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string>('all');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Transaction | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const params = {
    ...(accountId === 'all' ? {} : { accountId }),
    limit: PAGE_SIZE,
    offset,
  };
  const transactions = useQuery({
    queryKey: ['transactions', params],
    queryFn: () => fetchTransactions(params),
  });

  const page = transactions.data;
  const rows = page?.transactions ?? [];
  const filtered = accountId !== 'all';

  // Exports everything the filter matches, not just the page on screen.
  const exportCsv = useMutation({
    mutationFn: () => downloadTransactionsCsv(accountId === 'all' ? {} : { accountId }),
  });

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Transactions</h1>
        <p className="text-muted-foreground text-sm">
          Select a transaction to see its detail and split it across categories.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>
              {page ? `${page.total.toLocaleString()} transactions` : 'Loading…'}
            </CardTitle>
            <CardDescription>
              {page && page.total > 0
                ? `Showing ${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)}`
                : 'Nothing imported yet.'}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={accountId}
              onValueChange={(value) => {
                setAccountId(value);
                setOffset(0);
              }}
            >
              <SelectTrigger aria-label="Account filter" className="w-56">
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
            <Button
              size="sm"
              variant="outline"
              disabled={!page || page.total === 0 || exportCsv.isPending}
              onClick={() => exportCsv.mutate()}
            >
              {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {exportCsv.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(exportCsv.error)}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((transaction) => (
                <TableRow key={transaction.id}>
                  <TableCell className="whitespace-nowrap">{transaction.date}</TableCell>
                  <TableCell className="max-w-[18rem] truncate font-mono text-xs">
                    {transaction.description}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge
                        variant={transaction.category === 'UNCATEGORIZED' ? 'outline' : 'secondary'}
                      >
                        {transaction.category}
                      </Badge>
                      {transaction.splits.length > 0 && (
                        <Badge variant="default">split {transaction.splits.length}</Badge>
                      )}
                      {transaction.source === 'MANUAL' && <Badge variant="default">manual</Badge>}
                      {transaction.transferPairId && <Badge variant="outline">paired</Badge>}
                      {transaction.linkedRefundId && <Badge variant="outline">refunded</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={transaction.amount} />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(transaction)}>
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {transactions.isPending && <Loading label="Loading transactions…" />}

          {transactions.isError && (
            <ErrorState error={transactions.error} onRetry={() => void transactions.refetch()} />
          )}

          {!transactions.isPending && !transactions.isError && rows.length === 0 && (
            <EmptyState
              title={filtered ? 'Nothing in this account yet' : 'No transactions yet'}
              description={
                filtered
                  ? 'Try another account, or import a statement into this one.'
                  : 'Import a bank export and everything you spend will show up here.'
              }
              action={
                <Button asChild size="sm">
                  <Link to="/upload">Import a statement</Link>
                </Button>
              }
            />
          )}

          {page && page.total > PAGE_SIZE && (
            <div className="flex items-center gap-3 border-t pt-4">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <SplitDialog
        transaction={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['transactions'] });
          setSelected(null);
        }}
      />
    </main>
  );
}

export default TransactionsPage;
