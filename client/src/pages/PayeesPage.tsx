import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Amount } from '@/components/Amount';
import { PayeeDetail } from '@/components/PayeeDetail';
import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { fetchPayees, PAYEE_SORTS, type Payee, type PayeeSort } from '@/lib/payees';

type Filter = 'all' | 'PERSON' | 'BUSINESS';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'PERSON', label: 'People' },
  { value: 'BUSINESS', label: 'Businesses' },
];

/**
 * The running ledger, one row per counterparty.
 *
 * A transaction list sorted by date can tell you what happened on Tuesday. It
 * cannot tell you what you and Sam come to across six months, because the two
 * halves of that answer are hundreds of rows apart. This page is the answer:
 * every person and business you have transacted with, what has gone each way,
 * and what it nets out to.
 */
export function PayeesPage() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PayeeSort>('net');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Payee | null>(null);

  // The search goes to the server so it matches on the UPI address and phone
  // too, not only what happens to be rendered.
  const query = useQuery({
    queryKey: ['payees', { search, sort }],
    queryFn: () => fetchPayees({ ...(search.trim() ? { q: search.trim() } : {}), sort }),
  });

  const payees = useMemo(
    () => (query.data ?? []).filter((payee) => filter === 'all' || payee.type === filter),
    [query.data, filter],
  );

  const totals = useMemo(
    () =>
      payees.reduce(
        (sum, payee) => ({
          paid: sum.paid + payee.paid,
          received: sum.received + payee.received,
        }),
        { paid: 0, received: 0 },
      ),
    [payees],
  );

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>People &amp; Businesses</CardTitle>
          <CardDescription>
            Everyone you have paid or been paid by, with the running total for each. The same person
            appearing again on a different day joins the row they are already on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-xs"
              placeholder="Search a name, UPI address or number"
              aria-label="Search payees"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

            <Select value={sort} onValueChange={(value) => setSort(value as PayeeSort)}>
              <SelectTrigger className="w-44" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYEE_SORTS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    Sort: {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex gap-1" role="group" aria-label="Filter by kind">
              {FILTERS.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={filter === option.value ? 'default' : 'outline'}
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          {query.isPending && <Loading label="Loading your ledger…" />}
          {query.isError && (
            <ErrorState
              error={query.error}
              fallback="Could not load your payees."
              onRetry={() => void query.refetch()}
            />
          )}

          {query.isSuccess && payees.length === 0 && (
            <EmptyState
              title="Nobody here yet"
              description={
                search.trim()
                  ? `Nothing matches “${search.trim()}”.`
                  : 'Import a statement and the people and businesses in it will appear here.'
              }
            />
          )}

          {payees.length > 0 && (
            <>
              <p className="text-muted-foreground text-sm">
                {payees.length} {payees.length === 1 ? 'payee' : 'payees'} · paid{' '}
                <Amount value={totals.paid} direction="debit" /> · received{' '}
                <Amount value={totals.received} direction="credit" />
              </p>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Transactions</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payees.map((payee) => (
                    <TableRow key={payee.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{payee.displayName}</span>
                          <Badge variant={payee.type === 'PERSON' ? 'default' : 'outline'}>
                            {payee.type === 'PERSON' ? 'Person' : 'Business'}
                          </Badge>
                        </div>
                        {payee.upiVpa && (
                          <p className="text-muted-foreground text-xs">{payee.upiVpa}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Amount value={payee.paid} direction="debit" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Amount value={payee.received} direction="credit" />
                      </TableCell>
                      {/* Net carries its own sign — debit-positive, so being out
                      of pocket is the red one. */}
                      <TableCell className="text-right">
                        <Amount value={payee.net} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {payee.transactions}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {payee.lastTransactionAt ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => setSelected(payee)}>
                          History
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <PayeeDetail payee={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </main>
  );
}

export default PayeesPage;
