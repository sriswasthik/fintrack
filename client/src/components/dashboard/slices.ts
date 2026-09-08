/**
 * Folding a full category breakdown into the handful of slices a donut can carry.
 *
 * Pure, and separate from the component so it can be tested directly — the
 * arithmetic here decides what the chart claims, so it deserves its own tests.
 */
import type { CategoryTotal } from '@/lib/dashboard';
import type { Category } from '@/lib/transactions';

const MAX_SLICES = 6;

/** Fixed slot order — this ordering is what keeps adjacent arcs separable under
 *  colour-vision deficiency, so slices are assigned in order and never cycled. */
const SERIES = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;
const OTHER_COLOR = 'var(--muted-foreground)';

export interface DonutSlice {
  category: Category | 'OTHER';
  label: string;
  amount: number;
  share: number;
  color: string;
  members?: Category[];
}

/** Folds a full category breakdown into at most MAX_SLICES slices. */
export function toSlices(byCategory: CategoryTotal[]): DonutSlice[] {
  // Only positive spending is part of the whole; income and a category left net
  // negative by refunds are not slices of a spending pie.
  const spend = byCategory
    .filter((c) => c.category !== 'INCOME' && c.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const total = spend.reduce((sum, c) => sum + c.amount, 0);
  if (total === 0) return [];

  const head = spend.slice(0, MAX_SLICES - 1);
  const tail = spend.slice(MAX_SLICES - 1);

  const slices: DonutSlice[] = head.map((c, i) => ({
    category: c.category,
    label: c.category.replace(/_/g, ' '),
    amount: c.amount,
    share: Math.round((c.amount / total) * 1000) / 10,
    color: SERIES[i],
  }));

  if (tail.length > 0) {
    const amount = tail.reduce((sum, c) => sum + c.amount, 0);
    slices.push({
      category: 'OTHER',
      label: `Other (${tail.length})`,
      amount,
      share: Math.round((amount / total) * 1000) / 10,
      color: OTHER_COLOR,
      members: tail.map((c) => c.category),
    });
  }

  return slices;
}
