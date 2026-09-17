import { describe, expect, it } from 'vitest';

import { InvalidRangeError, resolveRange } from './range';

/** The window as a readable pair, since `from`/`to` are Dates. */
const bounds = (range: ReturnType<typeof resolveRange>) => ({
  from: range.from.toISOString(),
  to: range.to.toISOString(),
  startDate: range.startDate,
  endDate: range.endDate,
});

describe('daily', () => {
  it('covers exactly the one day asked for', () => {
    expect(bounds(resolveRange({ range: 'daily', date: '2026-06-15' }))).toEqual({
      from: '2026-06-15T00:00:00.000Z',
      to: '2026-06-16T00:00:00.000Z',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
    });
  });

  it('crosses a month boundary without widening', () => {
    // The half-open window is what makes this the 31st alone rather than the
    // 31st plus whatever an inclusive `<=` would drag in.
    expect(bounds(resolveRange({ range: 'daily', date: '2026-03-31' }))).toMatchObject({
      to: '2026-04-01T00:00:00.000Z',
      endDate: '2026-03-31',
    });
  });

  it('refuses a daily request with no date', () => {
    expect(() => resolveRange({ range: 'daily' })).toThrow(InvalidRangeError);
  });
});

describe('monthly', () => {
  it('covers the calendar month, first to last', () => {
    expect(bounds(resolveRange({ range: 'monthly', month: '2026-06' }))).toEqual({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
  });

  it('gets February right, leap year and not', () => {
    expect(resolveRange({ range: 'monthly', month: '2026-02' }).endDate).toBe('2026-02-28');
    expect(resolveRange({ range: 'monthly', month: '2028-02' }).endDate).toBe('2028-02-29');
  });

  it('rolls December into the next January', () => {
    expect(bounds(resolveRange({ range: 'monthly', month: '2026-12' }))).toMatchObject({
      to: '2027-01-01T00:00:00.000Z',
      endDate: '2026-12-31',
    });
  });

  it('reports the month it was given', () => {
    expect(resolveRange({ range: 'monthly', month: '2026-06' }).month).toBe('2026-06');
    expect(resolveRange({ range: 'daily', date: '2026-06-15' }).month).toBeNull();
  });

  it('refuses a monthly request with no month', () => {
    expect(() => resolveRange({ range: 'monthly' })).toThrow(InvalidRangeError);
  });
});

describe('custom', () => {
  it('treats the end date as inclusive', () => {
    // The caller names the last day they want counted; the window has to end
    // after it, or every custom range silently loses its final day.
    expect(
      bounds(resolveRange({ range: 'custom', startDate: '2026-04-01', endDate: '2026-06-30' })),
    ).toEqual({
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      startDate: '2026-04-01',
      endDate: '2026-06-30',
    });
  });

  it('accepts a single-day range', () => {
    expect(
      bounds(resolveRange({ range: 'custom', startDate: '2026-05-04', endDate: '2026-05-04' })),
    ).toMatchObject({ from: '2026-05-04T00:00:00.000Z', to: '2026-05-05T00:00:00.000Z' });
  });

  it('refuses an end before the start', () => {
    expect(() =>
      resolveRange({ range: 'custom', startDate: '2026-06-30', endDate: '2026-04-01' }),
    ).toThrow(InvalidRangeError);
  });

  it('refuses a half-specified range', () => {
    expect(() => resolveRange({ range: 'custom', startDate: '2026-04-01' })).toThrow(
      InvalidRangeError,
    );
    expect(() => resolveRange({ range: 'custom', endDate: '2026-06-30' })).toThrow(
      InvalidRangeError,
    );
  });
});
