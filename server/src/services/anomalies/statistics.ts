/**
 * The statistics the detectors are built from.
 *
 * Deliberately robust rather than classical: a quartile fence and a median
 * survive the very outliers we are hunting for, where a mean and a standard
 * deviation do not. PROJECT_CONTEXT.md §8 case 10 names this directly — a large
 * one-off purchase must be *found*, not allowed to quietly redefine "normal" and
 * mask everything after it.
 */

/** Linear-interpolated quantile over a sorted copy of the input. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation. Zero for fewer than two observations. */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface Fence {
  q1: number;
  q3: number;
  iqr: number;
  /** Above this, a value is an outlier. */
  upper: number;
}

/** Tukey's upper fence: Q3 + multiplier x IQR. */
export function upperFence(values: number[], multiplier = 1.5): Fence {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, upper: q3 + multiplier * iqr };
}

/** How many standard deviations a value sits above the mean. 0 when flat. */
export function zScore(value: number, values: number[]): number {
  const sd = standardDeviation(values);
  if (sd === 0) return 0;
  return (value - mean(values)) / sd;
}
