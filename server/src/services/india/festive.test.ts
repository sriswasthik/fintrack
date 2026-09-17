import { describe, expect, it } from 'vitest';

import { detectFestiveSpending, windowsFor } from './festive';
import type { IndiaTransaction } from './types';

let counter = 0;
const spend = (
  month: string,
  amount: number,
  category: IndiaTransaction['category'] = 'SHOPPING',
): IndiaTransaction => ({
  id: `f${++counter}`,
  date: `${month}-12`,
  amount,
  category,
  normalizedMerchant: 'A SHOP',
});

/** An ordinary run of months at a steady level. */
const baseline = (
  months: string[],
  amount: number,
  category: IndiaTransaction['category'] = 'SHOPPING',
) => months.map((m) => spend(m, amount, category));

const BEFORE_OCTOBER = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

describe('the festive calendar', () => {
  it('names the windows a month overlaps, and nothing for an ordinary month', () => {
    expect(windowsFor('2026-10').map((w) => w.key)).toEqual(['dussehra-diwali']);
    expect(windowsFor('2026-11').map((w) => w.key)).toEqual(['dussehra-diwali', 'wedding-season']);
    expect(windowsFor('2027-01').map((w) => w.key)).toEqual(['year-end-sales', 'wedding-season']);
    expect(windowsFor('2026-06')).toEqual([]);
  });
});

describe('it fires on a real festive bump', () => {
  it('reports a month above its own trailing median', () => {
    const rows = [...baseline(BEFORE_OCTOBER, 30000), spend('2026-10', 62000)];
    const note = detectFestiveSpending(rows, { month: '2026-10' });

    expect(note).toMatchObject({
      month: '2026-10',
      totalAbove: 32000,
    });
    expect(note?.categories[0]).toMatchObject({
      category: 'SHOPPING',
      amount: 62000,
      baseline: 30000,
      difference: 32000,
    });
    expect(note?.windows.map((w) => w.key)).toEqual(['dussehra-diwali']);
  });

  it('reports only the categories that actually moved', () => {
    // Shopping doubled; dining did not. A note that listed dining anyway would
    // be making a claim the data does not support.
    const rows = [
      ...baseline(BEFORE_OCTOBER, 30000),
      ...baseline(BEFORE_OCTOBER, 12000, 'DINING'),
      spend('2026-10', 62000),
      spend('2026-10', 12500, 'DINING'),
    ];
    const note = detectFestiveSpending(rows, { month: '2026-10' });
    expect(note?.categories.map((c) => c.category)).toEqual(['SHOPPING']);
  });

  it('orders by how much money moved, not by category name', () => {
    const rows = [
      ...baseline(BEFORE_OCTOBER, 30000),
      ...baseline(BEFORE_OCTOBER, 12000, 'DINING'),
      spend('2026-10', 45000),
      spend('2026-10', 40000, 'DINING'),
    ];
    const note = detectFestiveSpending(rows, { month: '2026-10' });
    expect(note?.categories.map((c) => c.category)).toEqual(['DINING', 'SHOPPING']);
  });
});

describe('the wording stays neutral', () => {
  const note = detectFestiveSpending(
    [...baseline(BEFORE_OCTOBER, 30000), spend('2026-10', 62000)],
    { month: '2026-10' },
  );

  it('states the comparison and the calendar, and draws no conclusion', () => {
    expect(note?.note).toContain('October 2026');
    expect(note?.note).toContain('your own six-month median');
    expect(note?.note).toContain('overlaps the Dussehra and Diwali period');
  });

  it('never tells anybody off', () => {
    // The tone is the feature. A note that reads as a telling-off is worse than
    // no note, and "overspent" is a judgement the data cannot support.
    expect(note?.note).not.toMatch(
      /overspen|too much|excessive|should|careful|unusually|warning|alarm|blow|splurg|!/i,
    );
  });

  it('never claims the festival caused the spending', () => {
    // Two separate facts — the spend and the calendar — deliberately not
    // joined by a "because". The statement cannot know why.
    expect(note?.note).not.toMatch(/\bbecause\b|\bdue to\b|\bcaused\b|\bthanks to\b/i);
  });

  it('compares them only to themselves', () => {
    expect(note?.note).not.toMatch(/average (indian|household|user)|other people|typical family/i);
  });
});

describe('it does not fire where it should not', () => {
  it('says nothing about a month outside every festive window', () => {
    const rows = [
      ...baseline(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'], 30000),
      spend('2026-06', 90000),
    ];
    expect(detectFestiveSpending(rows, { month: '2026-06' })).toBeNull();
  });

  it('says nothing when the festive month is ordinary', () => {
    const rows = [...baseline(BEFORE_OCTOBER, 30000), spend('2026-10', 31500)];
    expect(detectFestiveSpending(rows, { month: '2026-10' })).toBeNull();
  });

  it('says nothing without enough history to have a baseline', () => {
    // Two months is not a baseline, and the first months of any import would
    // otherwise produce a note about every festival.
    const rows = [...baseline(['2026-08', '2026-09'], 30000), spend('2026-10', 90000)];
    expect(detectFestiveSpending(rows, { month: '2026-10' })).toBeNull();
  });

  it('will not let a small category trip it on a big ratio', () => {
    // ₹900 to ₹2,700 has tripled without anything happening.
    const rows = [...baseline(BEFORE_OCTOBER, 900), spend('2026-10', 2700)];
    expect(detectFestiveSpending(rows, { month: '2026-10' })).toBeNull();
  });

  it('will not let a big category trip it on a small ratio', () => {
    // ₹9,000 more on a ₹90,000 baseline clears the rupee floor and nothing else.
    const rows = [...baseline(BEFORE_OCTOBER, 90000), spend('2026-10', 99000)];
    expect(detectFestiveSpending(rows, { month: '2026-10' })).toBeNull();
  });

  it('does not count a month with no data as a month of spending nothing', () => {
    // Months before the import began are absent, not zero. Counting them as
    // zero would halve the baseline and manufacture a finding.
    const rows = [...baseline(['2026-08', '2026-09'], 30000), spend('2026-10', 45000)];
    expect(detectFestiveSpending(rows, { month: '2026-10' })).toBeNull();
  });

  it('judges the month against the months before it, not including itself', () => {
    // Including October in its own baseline drags the baseline towards it and
    // buries exactly the move being looked for.
    const rows = [...baseline(BEFORE_OCTOBER, 30000), spend('2026-10', 45000)];
    const note = detectFestiveSpending(rows, { month: '2026-10' });
    expect(note?.categories[0].baseline).toBe(30000);
  });

  it('ignores a credit in a watched category', () => {
    const rows = [...baseline(BEFORE_OCTOBER, 30000), spend('2026-10', -62000)];
    expect(detectFestiveSpending(rows, { month: '2026-10' })).toBeNull();
  });
});
