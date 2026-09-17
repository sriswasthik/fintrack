import { describe, expect, it } from 'vitest';

import { isoDate, isoMonth, quarterRange } from '@/lib/totals';

/** A local-time date, which is what a person's calendar means by a day. */
const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h);

describe('isoDate', () => {
  it('reads the local calendar day, not the UTC one', () => {
    // 11pm on the 17th in India is already the 18th in UTC. Formatting via
    // toISOString would hand back the wrong "today" for most of the evening.
    expect(isoDate(local(2026, 9, 17, 23))).toBe('2026-09-17');
    expect(isoDate(local(2026, 9, 17, 1))).toBe('2026-09-17');
  });

  it('pads single-digit months and days', () => {
    expect(isoDate(local(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('isoMonth', () => {
  it('is the local calendar month', () => {
    expect(isoMonth(local(2026, 9, 17))).toBe('2026-09');
    expect(isoMonth(local(2026, 12, 31, 23))).toBe('2026-12');
  });
});

describe('quarterRange', () => {
  it('covers the calendar quarter the date falls in', () => {
    expect(quarterRange(local(2026, 2, 14))).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    });
    expect(quarterRange(local(2026, 5, 4))).toEqual({
      startDate: '2026-04-01',
      endDate: '2026-06-30',
    });
    expect(quarterRange(local(2026, 9, 17))).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-09-30',
    });
    expect(quarterRange(local(2026, 12, 31))).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-12-31',
    });
  });

  it('lands on the real last day of the quarter', () => {
    // Q1 ends on the 31st, Q2 on the 30th. Day 0 of the following month is how
    // that is got right without a table of month lengths.
    expect(quarterRange(local(2026, 1, 1)).endDate).toBe('2026-03-31');
    expect(quarterRange(local(2026, 4, 1)).endDate).toBe('2026-06-30');
  });

  it('holds on every boundary of the year', () => {
    for (let month = 1; month <= 12; month += 1) {
      const range = quarterRange(local(2026, month, 1));
      const startMonth = Number(range.startDate.slice(5, 7));
      expect(startMonth).toBe(Math.floor((month - 1) / 3) * 3 + 1);
      expect(range.endDate > range.startDate).toBe(true);
    }
  });
});
