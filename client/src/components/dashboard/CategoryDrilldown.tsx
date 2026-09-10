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
import { fetchTransactions, type Category } from '@/lib/transactions';
import { formatINR } from '@/lib/currency';


/**
 * The transactions behind one number on the dashboard.
 *
 * Every aggregate should be answerable with "which rows made this?", so each
 * category total opens the list it was computed from.
 */
export function CategoryDrilldown({
  category,
  month,
  accountId,
  onOpenChange,
}: {
  category: Category | null;
  month: string | null;
  accountId?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const params = {
    ...(category ? { category } : {}),
    ...(month ? { month } : {}),
    ...(accountId ? { accountId } : {}),
    limit: 200,
  };

  const query = useQuery({
    queryKey: ['transactions', params],
    queryFn: () => fetchTransactions(params),
    enabled: Boolean(category),
  });

  const rows = query.data?.transactions ?? [];
  const total = rows.reduce((sum, t) => sum + t.amount, 0);

  return (
    <Dialog open={Boolean(category)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{category?.replace(/_/g, ' ')}</DialogTitle>
          <DialogDescription>
            {query.isPending
              ? 'Loading…'
              : `${query.data?.total ?? 0} transaction(s)${month ? ` in ${month}` : ''} · ${formatINR(total)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((transaction) => (
                <TableRow key={transaction.id}>
                  <TableCell className="whitespace-nowrap">{transaction.date}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{transaction.normalizedMerchant || '—'}</span>
                      {transaction.splits.length > 0 && <Badge variant="outline">split</Badge>}
                    </div>
                    <div className="text-muted-foreground max-w-[18rem] truncate font-mono text-xs">
                      {transaction.description}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatINR(transaction.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
