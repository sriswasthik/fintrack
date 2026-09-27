import { describe, expect, it } from 'vitest';

import { UNBUDGETABLE, WARNING_RATIO, budgetProgress, monthElapsed } from './progress';

describe('budgetProgress', () => {
  it('is ok comfortably under the limit', () => {
    expect(budgetProgress('DINING', 10000, 4000)).toEqual({
      category: 'DINING',
      amount: 10000,
      spent: 4000,
      remaining: 6000,
      percent: 40,
      status: 'ok',
    });
  });

  it('warns from exactly the warning ratio', () => {
    expect(WARNING_RATIO).toBe(0.8);
    expect(budgetProgress('DINING', 10000, 7999.99).status).toBe('ok');
    expect(budgetProgress('DINING', 10000, 8000).status).toBe('warning');
  });

  it('is not over at exactly the limit, only past it', () => {
    expect(budgetProgress('DINING', 10000, 10000)).toMatchObject({
      status: 'warning',
      remaining: 0,
      percent: 100,
    });
    expect(budgetProgress('DINING', 10000, 10000.01)).toMatchObject({
      status: 'over',
      remaining: -0.01,
    });
  });

  it('reports how far over as a negative remainder', () => {
    expect(budgetProgress('SHOPPING', 5000, 7250.5)).toMatchObject({
      spent: 7250.5,
      remaining: -2250.5,
      percent: 145,
      status: 'over',
    });
  });

  it('treats a month of net refunds as nothing spent rather than negative spending', () => {
    expect(budgetProgress('SHOPPING', 5000, -1200)).toMatchObject({
      spent: 0,
      remaining: 5000,
      percent: 0,
      status: 'ok',
    });
  });

  it('rounds to paise', () => {
    expect(budgetProgress('GROCERIES', 3333.333, 1111.1111)).toMatchObject({
      amount: 3333.33,
      spent: 1111.11,
      remaining: 2222.22,
      percent: 33.3,
    });
  });
});

describe('UNBUDGETABLE', () => {
  it('covers money arriving, own-account moves and the refund bucket', () => {
    expect([...UNBUDGETABLE].sort()).toEqual(['INCOME', 'REFUND', 'TRANSFER']);
  });
});

describe('monthElapsed', () => {
  it('is 1 for a month that has ended', () => {
    expect(monthElapsed('2026-06', new Date('2026-09-22T00:00:00Z'))).toBe(1);
  });

  it('is 0 for a month that has not begun', () => {
    expect(monthElapsed('2026-10', new Date('2026-09-22T00:00:00Z'))).toBe(0);
  });

  it('is the fraction of the month gone by', () => {
    // Noon on 16 June is 15.5 days into a 30-day month.
    expect(monthElapsed('2026-06', new Date('2026-06-16T12:00:00Z'))).toBeCloseTo(15.5 / 30, 3);
  });
});
