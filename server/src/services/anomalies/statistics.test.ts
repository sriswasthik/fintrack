import { describe, expect, it } from 'vitest';

import { mean, median, quantile, standardDeviation, upperFence, zScore } from './statistics';

describe('quantile', () => {
  it('interpolates between neighbours rather than picking one', () => {
    // Position 1.5 in [1, 2, 3, 4] sits halfway between 2 and 3.
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
  });

  it('sorts its input rather than trusting the caller', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
  });

  it('leaves the caller-s array untouched', () => {
    const values = [3, 1, 2];
    quantile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it('answers 0 for nothing', () => {
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('median', () => {
  it('is the middle of an odd-length set', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('shrugs off an extreme value that would move a mean', () => {
    expect(median([10, 11, 12, 13, 5000])).toBe(12);
    expect(mean([10, 11, 12, 13, 5000])).toBeGreaterThan(1000);
  });
});

describe('standardDeviation', () => {
  it('is the sample deviation, not the population one', () => {
    // Sum of squares 10 over n-1 = 4 gives 2.5; the population form would give 2.
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it('is 0 when there is nothing to vary', () => {
    expect(standardDeviation([7])).toBe(0);
    expect(standardDeviation([])).toBe(0);
    expect(standardDeviation([3, 3, 3])).toBe(0);
  });
});

describe('upperFence', () => {
  it('is Q3 plus the multiplier times the IQR', () => {
    const fence = upperFence([1, 2, 3, 4, 5, 6, 7, 8], 1.5);
    expect(fence.q1).toBe(2.75);
    expect(fence.q3).toBe(6.25);
    expect(fence.iqr).toBeCloseTo(3.5, 10);
    expect(fence.upper).toBeCloseTo(11.5, 10);
  });

  it('is not dragged upwards by the outlier it is meant to catch', () => {
    const ordinary = [20, 22, 25, 25, 28, 30, 31, 35];
    const withOutlier = [...ordinary, 3299];

    // A standard-deviation band moves far enough to swallow the outlier whole.
    expect(mean(ordinary) + 3 * standardDeviation(ordinary)).toBeLessThan(100);
    expect(mean(withOutlier) + 3 * standardDeviation(withOutlier)).toBeGreaterThan(3299);

    // The quartile fence barely moves, so 3299 is still outside it.
    expect(upperFence(withOutlier).upper).toBeLessThan(60);
  });
});

describe('zScore', () => {
  it('counts standard deviations above the mean', () => {
    expect(zScore(9, [1, 3, 5, 7, 9])).toBeCloseTo(1.265, 3);
  });

  it('is 0 rather than Infinity when nothing varies', () => {
    expect(zScore(10, [5, 5, 5])).toBe(0);
  });
});
