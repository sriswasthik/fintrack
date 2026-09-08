import { describe, expect, it } from 'vitest';

import {
  addDays,
  comparisonWindow,
  monthWindow,
  percentageChange,
  rangeWindow,
  toIsoDate,
  toIsoMonth,
} from './window';

const iso = (window: { from: Date; to: Date }) => [toIsoDate(window.from), toIsoDate(window.to)];

describe('monthWindow', () => {
  it('is half-open: the first of the month to the first of the next', () => {
    expect(iso(monthWindow('2026-06'))).toEqual(['2026-06-01', '2026-07-01']);
  });

  it.each([
    ['2026-02', ['2026-02-01', '2026-03-01']],
    ['2026-12', ['2026-12-01', '2027-01-01']],
    ['2026-01', ['2026-01-01', '2026-02-01']],
  ])('handles %s', (month, expected) => {
    expect(iso(monthWindow(month))).toEqual(expected);
  });

  it('covers a leap February', () => {
    const window = monthWindow('2028-02');
    expect(toIsoDate(addDays(window.to, -1))).toBe('2028-02-29');
  });
});

describe('rangeWindow', () => {
  it('treats the caller-supplied end date as inclusive', () => {
    // A range of 2026-06-01..2026-06-07 must include the 7th, so the half-open
    // window ends on the 8th.
    expect(iso(rangeWindow('2026-06-01', '2026-06-07'))).toEqual(['2026-06-01', '2026-06-08']);
  });

  it('handles a single day', () => {
    expect(iso(rangeWindow('2026-06-15', '2026-06-15'))).toEqual(['2026-06-15', '2026-06-16']);
  });
});

describe('comparisonWindow', () => {
  it('compares a month with the previous calendar month, not the previous 30 days', () => {
    // February is short. Comparing it against "the previous 30 days" would make
    // every February look like a collapse.
    expect(iso(comparisonWindow(monthWindow('2026-03'), '2026-03'))).toEqual([
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(iso(comparisonWindow(monthWindow('2026-01'), '2026-01'))).toEqual([
      '2025-12-01',
      '2026-01-01',
    ]);
  });

  it('compares a custom range with the preceding window of the same length', () => {
    const current = rangeWindow('2026-06-11', '2026-06-20'); // 10 days
    expect(iso(comparisonWindow(current))).toEqual(['2026-06-01', '2026-06-11']);
  });

  it('never overlaps the current window', () => {
    const current = rangeWindow('2026-06-11', '2026-06-20');
    expect(comparisonWindow(current).to.getTime()).toBe(current.from.getTime());
  });

  it('gives a single day the day before it', () => {
    expect(iso(comparisonWindow(rangeWindow('2026-06-15', '2026-06-15')))).toEqual([
      '2026-06-14',
      '2026-06-15',
    ]);
  });
});

describe('percentageChange', () => {
  it.each([
    [150, 100, 50],
    [50, 100, -50],
    [100, 100, 0],
    [8959.49, 13295.66, -32.6],
  ])('reports %i against %i as %f%%', (current, previous, expected) => {
    expect(percentageChange(current, previous)).toBe(expected);
  });

  it('is null when the baseline was zero, since a ratio means nothing there', () => {
    expect(percentageChange(500, 0)).toBeNull();
    expect(percentageChange(0, 0)).toBeNull();
  });

  it('uses the magnitude of a negative baseline, so the sign is the direction of change', () => {
    expect(percentageChange(-50, -100)).toBe(50);
  });

  it('rounds to one decimal place', () => {
    expect(percentageChange(1234, 1000)).toBe(23.4);
  });
});

describe('date helpers', () => {
  it('formats an ISO date and month in UTC', () => {
    expect(toIsoDate(new Date('2026-06-15T23:30:00.000Z'))).toBe('2026-06-15');
    expect(toIsoMonth(new Date('2026-06-15T23:30:00.000Z'))).toBe('2026-06');
  });

  it('adds and subtracts days across a month boundary', () => {
    expect(toIsoDate(addDays(new Date('2026-06-30T00:00:00.000Z'), 1))).toBe('2026-07-01');
    expect(toIsoDate(addDays(new Date('2026-07-01T00:00:00.000Z'), -1))).toBe('2026-06-30');
  });
});
