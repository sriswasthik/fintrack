import { describe, expect, it } from 'vitest';

import { toSlices } from '@/components/dashboard/slices';
import type { CategoryTotal } from '@/lib/dashboard';
import type { Category } from '@/lib/transactions';

function total(category: Category, amount: number): CategoryTotal {
  return { category, amount, transactions: 1, share: 0 };
}

describe('toSlices', () => {
  it('orders slices by amount, largest first', () => {
    const slices = toSlices([total('DINING', 100), total('HOUSING', 500), total('TRAVEL', 300)]);
    expect(slices.map((s) => s.category)).toEqual(['HOUSING', 'TRAVEL', 'DINING']);
  });

  it('never exceeds eight rows, however many categories there are', () => {
    // Seven named rows and Other: the taxonomy has 20, and a list that long
    // stops being something the eye can rank.
    const many = [
      'HOUSING',
      'SHOPPING',
      'TRAVEL',
      'GROCERIES',
      'DINING',
      'UTILITIES',
      'ENTERTAINMENT',
      'BUSINESS',
      'INSURANCE',
      'EDUCATION',
    ] as Category[];
    const slices = toSlices(many.map((c, i) => total(c, (10 - i) * 100)));

    expect(slices).toHaveLength(8);
    expect(slices[7].category).toBe('OTHER');
  });

  it('folds the tail into Other', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as unknown as Category[];
    const slices = toSlices(many.map((c, i) => total(c, (9 - i) * 100)));
    const other = slices[slices.length - 1];

    // Seven named rows plus Other, so the two smallest fold: 200 + 100.
    expect(other).toMatchObject({ category: 'OTHER', amount: 300 });
    expect(other.members).toEqual(['H', 'I']);
    expect(other.label).toBe('Other (2)');
  });

  it('names all eight when there are exactly eight, rather than folding one', () => {
    const eight = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as unknown as Category[];
    const slices = toSlices(eight.map((c, i) => total(c, (8 - i) * 100)));
    expect(slices.map((s) => s.category)).toEqual(eight);
  });

  it('excludes INCOME — where the money went is not a picture of earnings', () => {
    const slices = toSlices([total('HOUSING', 500), total('INCOME', -10926.72)]);
    expect(slices.map((s) => s.category)).toEqual(['HOUSING']);
  });

  it('excludes a category left net negative by refunds, which cannot be a bar', () => {
    const slices = toSlices([total('HOUSING', 500), total('SHOPPING', -120)]);
    expect(slices.map((s) => s.category)).toEqual(['HOUSING']);
  });

  it('computes shares against the spending that is actually drawn', () => {
    const slices = toSlices([total('HOUSING', 750), total('DINING', 250)]);
    expect(slices.map((s) => s.share)).toEqual([75, 25]);
    expect(slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(100, 1);
  });

  it('labels a category readably', () => {
    expect(toSlices([total('HEALTH_FITNESS', 100)])[0].label).toBe('HEALTH FITNESS');
  });

  it('returns nothing when there is no spending to draw', () => {
    expect(toSlices([])).toEqual([]);
    expect(toSlices([total('INCOME', -500)])).toEqual([]);
  });

  it('reproduces the hand-verified June breakdown', () => {
    // These are the figures checked against the seeded database by hand.
    const slices = toSlices([
      total('HOUSING', 2150),
      total('SHOPPING', 1945.84),
      total('TRAVEL', 1052.14),
      total('GROCERIES', 781.89),
      total('DINING', 638.84),
      total('UNCATEGORIZED', 592.18),
      total('GIFTS_DONATIONS', 432.47),
      total('TRANSPORTATION', 401.09),
      total('ENTERTAINMENT', 317.96),
      total('UTILITIES', 226.03),
      total('HEALTH_FITNESS', 151.55),
      total('PERSONAL_CARE', 125.56),
      total('SUBSCRIPTIONS', 74.95),
      total('BUSINESS', 46.51),
      total('INSURANCE', 18.5),
      total('FEES_INTEREST', 3.98),
      total('INCOME', -10926.72),
    ]);

    expect(slices).toHaveLength(8);
    expect(slices[0]).toMatchObject({ category: 'HOUSING', amount: 2150, share: 24 });
    // Every slice together is the whole spend figure the dashboard leads with.
    expect(slices.reduce((sum, s) => sum + s.amount, 0)).toBeCloseTo(8959.49, 2);
  });
});
