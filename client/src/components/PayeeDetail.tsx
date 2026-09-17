import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Amount } from '@/components/Amount';
import { ErrorState, Loading } from '@/components/states';
import type { AmountDirection } from '@/lib/amount';
import { fetchPayee, type Payee } from '@/lib/payees';

/** One figure from the ledger, with the word for what it means underneath. */
function Total({
  label,
  value,
  direction,
  hint,
}: {
  label: string;
  value: number;
  /** Paid and received are stored as magnitudes, so they have to say which way. */
  direction?: AmountDirection;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <Amount value={value} direction={direction} className="text-lg font-semibold" />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/**
 * Everything one counterparty has ever come to.
 *
 * The three totals sit above the rows they are computed from, on purpose: the
 * whole point of the ledger is that "you have paid Sam ₹4,750 and Sam has paid
 * you ₹3,900" is checkable, and it is only checkable if the rows are right
 * there to add up.
 */
export function PayeeDetail({
  payee,
  onOpenChange,
}: {
  payee: Payee | null;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useQuery({
    queryKey: ['payee', payee?.id],
    queryFn: () => fetchPayee(payee!.id),
    enabled: Boolean(payee),
  });

  const detail = query.data;
  const history = detail?.transactionHistory ?? [];

  return (
    <Dialog open={Boolean(payee)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {payee?.displayName}
            {payee && (
              <Badge variant={payee.type === 'PERSON' ? 'default' : 'outline'}>
                {payee.type === 'PERSON' ? 'Person' : 'Business'}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {[
              payee?.upiVpa,
              payee?.phone && !payee.upiVpa?.startsWith(payee.phone) ? payee.phone : null,
              detail ? `${detail.transactions} transaction(s)` : null,
              detail?.firstTransactionAt ? `since ${detail.firstTransactionAt}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'No transactions yet'}
          </DialogDescription>
        </DialogHeader>

        {query.isPending && <Loading label="Loading this payee’s history…" />}
        {query.isError && <ErrorState error={query.error} fallback="Could not load this payee." />}

        {detail && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Total label="Paid to them" value={detail.paid} direction="debit" />
              <Total label="Received from them" value={detail.received} direction="credit" />
              <Total
                label="Net"
                value={detail.net}
                hint={
                  detail.net === 0
                    ? 'Square'
                    : detail.net > 0
                      ? 'You are out of pocket'
                      : 'They are out of pocket'
                }
              />
            </div>

            <div className="max-h-[50vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((transaction) => (
                    <TableRow key={transaction.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {transaction.date}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{transaction.description}</span>
                          <Badge variant="outline">
                            {transaction.direction === 'paid' ? 'paid' : 'received'}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {transaction.category.replace(/_/g, ' ')}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{transaction.accountName}</TableCell>
                      <TableCell className="text-right">
                        <Amount value={transaction.amount} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default PayeeDetail;
