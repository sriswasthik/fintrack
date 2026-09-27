/**
 * Folding a full category breakdown into the rows a ranked bar list can carry.
 *
 * Pure, and separate from the component so it can be tested directly — the
 * arithmetic here decides what the chart claims, so it deserves its own tests.
 *
 * No colours are assigned here any more. The bars are one series — how much
 * went where — so every bar wears the same ink and its length does the work;
 * colouring them by rank would spend the colour channel re-saying what the
 * length already says, and repaint a category whenever its rank changed.
 */
import type { CategoryTotal } from '@/lib/dashboard';
import type { Category } from '@/lib/transactions';

/** Seven named categories and an Other row: enough to read, short enough to scan. */
const MAX_ROWS = 8;

export interface CategorySlice {
  category: Category | 'OTHER';
  label: string;
  amount: number;
  share: number;
  members?: Category[];
}

/** Folds a full category breakdown into at most MAX_ROWS rows, largest first. */
export function toSlices(byCategory: CategoryTotal[]): CategorySlice[] {
  // Only positive spending is part of the whole; income and a category left net
  // negative by refunds are not part of where the money went.
  const spend = byCategory
    .filter((c) => c.category !== 'INCOME' && c.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const total = spend.reduce((sum, c) => sum + c.amount, 0);
  if (total === 0) return [];

  const share = (amount: number) => Math.round((amount / total) * 1000) / 10;
  const named = spend.length > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS;

  const rows: CategorySlice[] = spend.slice(0, named).map((c) => ({
    category: c.category,
    label: c.category.replace(/_/g, ' '),
    amount: c.amount,
    share: share(c.amount),
  }));

  const tail = spend.slice(named);
  if (tail.length > 0) {
    const amount = tail.reduce((sum, c) => sum + c.amount, 0);
    rows.push({
      category: 'OTHER',
      label: `Other (${tail.length})`,
      amount,
      share: share(amount),
      members: tail.map((c) => c.category),
    });
  }

  return rows;
}
