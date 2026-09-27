import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatINR } from '@/lib/currency';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CATEGORIES,
  splitTransaction,
  type Category,
  type SplitInput,
  type Transaction,
} from '@/lib/transactions';
import { errorMessage } from '@/lib/errors';

/** Amounts are compared in whole cents, exactly as the server does. */
const cents = (amount: number) => Math.round(amount * 100);

interface DraftPart {
  category: Category;
  /** Kept as a string so a half-typed "12." does not get coerced away. */
  amount: string;
  note: string;
}

/**
 * Transaction detail, with the split editor (PROJECT_CONTEXT.md §8 case 3).
 *
 * The parts must sum to the transaction's total exactly — the server enforces
 * it, and this shows the running remainder so the requirement is visible while
 * typing rather than only on rejection.
 */
export function SplitDialog({
  transaction,
  onOpenChange,
  onSaved,
}: {
  transaction: Transaction | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={Boolean(transaction)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {transaction && (
          // Keyed by id so opening a different transaction remounts the form
          // with fresh state, instead of syncing props into state in an effect.
          <SplitForm
            key={transaction.id}
            transaction={transaction}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Builds the starting parts: the existing split, or the whole amount plus an empty part. */
function initialParts(transaction: Transaction): DraftPart[] {
  if (transaction.splits.length > 0) {
    return transaction.splits.map((s) => ({
      category: s.category,
      amount: s.amount.toFixed(2),
      note: s.note ?? '',
    }));
  }
  return [
    { category: transaction.category, amount: transaction.amount.toFixed(2), note: '' },
    { category: 'UNCATEGORIZED', amount: '0.00', note: '' },
  ];
}

function SplitForm({
  transaction,
  onCancel,
  onSaved,
}: {
  transaction: Transaction;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [parts, setParts] = useState<DraftPart[]>(() => initialParts(transaction));

  const mutation = useMutation({
    mutationFn: (splits: SplitInput[]) =>
      splitTransaction({ transactionId: transaction.id, splits }),
    onSuccess: onSaved,
  });

  const total = transaction.amount;
  const allocated = useMemo(
    () => parts.reduce((sum, part) => sum + (Number(part.amount) || 0), 0),
    [parts],
  );
  const remainder = useMemo(() => (cents(total) - cents(allocated)) / 100, [total, allocated]);

  const balanced = cents(remainder) === 0;
  const canSave = balanced && parts.length >= 2 && !mutation.isPending;

  function update(index: number, patch: Partial<DraftPart>) {
    setParts((prev) => prev.map((part, i) => (i === index ? { ...part, ...patch } : part)));
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Split this transaction</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{transaction.description}</span> · {transaction.date} ·{' '}
          {formatINR(transaction.amount)}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">{transaction.category}</Badge>
          <span>merchant {transaction.normalizedMerchant}</span>
          <span>· source {transaction.source}</span>
        </div>

        <div className="space-y-2">
          {parts.map((part, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-44 flex-1">
                <Select
                  value={part.category}
                  onValueChange={(value) => update(index, { category: value as Category })}
                >
                  <SelectTrigger aria-label={`Category for part ${index + 1}`} className="w-full">
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
              </div>
              <Input
                className="w-28 text-right"
                inputMode="decimal"
                aria-label={`Amount for part ${index + 1}`}
                value={part.amount}
                onChange={(event) => update(index, { amount: event.target.value })}
              />
              <Input
                className="min-w-40 flex-1"
                aria-label={`Note for part ${index + 1}`}
                placeholder="Note (optional)"
                value={part.note}
                onChange={(event) => update(index, { note: event.target.value })}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove part ${index + 1}`}
                disabled={parts.length <= 2}
                onClick={() => setParts((prev) => prev.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setParts((prev) => [
                ...prev,
                { category: 'UNCATEGORIZED', amount: remainder.toFixed(2), note: '' },
              ])
            }
          >
            Add part
          </Button>
          <span
            role="status"
            className={balanced ? 'text-muted-foreground' : 'text-destructive font-medium'}
          >
            {balanced
              ? `Allocated ${formatINR(allocated)} of ${formatINR(total)}`
              : `${formatINR(Math.abs(remainder))} ${remainder > 0 ? 'left to allocate' : 'over the total'}`}
          </span>
        </div>

        {mutation.isError && (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(mutation.error)}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!canSave}
          onClick={() =>
            mutation.mutate(
              parts.map((part) => ({
                category: part.category,
                amount: Number(part.amount) || 0,
                ...(part.note.trim() ? { note: part.note.trim() } : {}),
              })),
            )
          }
        >
          {mutation.isPending ? 'Saving…' : 'Save split'}
        </Button>
      </DialogFooter>
    </>
  );
}
