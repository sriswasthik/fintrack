import { describe, expect, it } from 'vitest';

import type { ParsedRow } from './csv';
import { dateRangeOf, flagDuplicates, type ExistingTransaction } from './dedup';

function row(overrides: Partial<ParsedRow> & { index: number }): ParsedRow {
  return {
    date: '2026-04-10',
    postedDate: null,
    description: 'WHOLE FOODS MKT #104',
    rawMerchant: 'WHOLE FOODS MKT #104',
    normalizedMerchant: 'WHOLE FOODS',
    amount: 64.18,
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingTransaction> = {}): ExistingTransaction {
  return {
    id: 'txn_1',
    date: '2026-04-10',
    amount: 64.18,
    normalizedMerchant: 'WHOLE FOODS',
    ...overrides,
  };
}

describe('flagDuplicates against already-stored transactions', () => {
  it('flags an exact match on date, amount and merchant', () => {
    const [flagged] = flagDuplicates([row({ index: 1 })], [existing()]);

    expect(flagged.duplicate).toMatchObject({
      kind: 'existing',
      existingTransactionId: 'txn_1',
      existingDate: '2026-04-10',
    });
  });

  it.each([
    ['the day before', '2026-04-09'],
    ['the same day', '2026-04-10'],
    ['the day after', '2026-04-11'],
  ])('flags a match dated %s (±1 day window)', (_label, date) => {
    const [flagged] = flagDuplicates([row({ index: 1 })], [existing({ date })]);
    expect(flagged.duplicate?.kind).toBe('existing');
  });

  it.each([
    ['two days earlier', '2026-04-08'],
    ['two days later', '2026-04-12'],
  ])('does not flag a match dated %s', (_label, date) => {
    const [flagged] = flagDuplicates([row({ index: 1 })], [existing({ date })]);
    expect(flagged.duplicate).toBeNull();
  });

  it('does not flag a different amount', () => {
    const [flagged] = flagDuplicates([row({ index: 1 })], [existing({ amount: 64.19 })]);
    expect(flagged.duplicate).toBeNull();
  });

  it('does not flag a different merchant', () => {
    const [flagged] = flagDuplicates(
      [row({ index: 1 })],
      [existing({ normalizedMerchant: 'ALDI' })],
    );
    expect(flagged.duplicate).toBeNull();
  });

  it('compares amounts in whole cents rather than by float equality', () => {
    const [flagged] = flagDuplicates(
      [row({ index: 1, amount: 0.1 + 0.2 })],
      [existing({ amount: 0.3 })],
    );
    expect(flagged.duplicate?.kind).toBe('existing');
  });

  it('matches a negative amount (a refund re-imported) as readily as a purchase', () => {
    const [flagged] = flagDuplicates(
      [row({ index: 1, amount: -128.9 })],
      [existing({ amount: -128.9 })],
    );
    expect(flagged.duplicate?.kind).toBe('existing');
  });

  it('leaves every row unflagged when the account is empty', () => {
    const rows = [row({ index: 1 }), row({ index: 2, date: '2026-05-01' })];
    expect(flagDuplicates(rows, []).every((r) => r.duplicate === null)).toBe(true);
  });
});

describe('flagDuplicates within a single file', () => {
  it('flags the second of two identical rows, not the first', () => {
    // PROJECT_CONTEXT.md §8 case 5: a sync glitch posts the same charge twice.
    const flagged = flagDuplicates([row({ index: 1 }), row({ index: 2 })], []);

    expect(flagged[0].duplicate).toBeNull();
    expect(flagged[1].duplicate).toMatchObject({ kind: 'in-file', matchesRowIndex: 1 });
  });

  it('flags a legitimate same-day repeat too, because it is indistinguishable', () => {
    // Two coffees on one day at the same price. The matcher cannot tell these
    // from a glitch, which is exactly why the user resolves them by hand.
    const coffee = {
      description: 'SQ *JOES COFFEE',
      rawMerchant: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
      amount: 5.25,
    };
    const flagged = flagDuplicates(
      [row({ index: 1, ...coffee }), row({ index: 2, ...coffee })],
      [],
    );

    expect(flagged[1].duplicate?.kind).toBe('in-file');
  });

  it('does not flag repeats of the same merchant at different amounts', () => {
    const flagged = flagDuplicates(
      [row({ index: 1, amount: 4.75 }), row({ index: 2, amount: 5.5 })],
      [],
    );
    expect(flagged.every((r) => r.duplicate === null)).toBe(true);
  });

  it('prefers an existing-transaction match over an in-file one', () => {
    const flagged = flagDuplicates([row({ index: 1 }), row({ index: 2 })], [existing()]);
    expect(flagged.map((r) => r.duplicate?.kind)).toEqual(['existing', 'existing']);
  });

  it('preserves row order and every parsed field', () => {
    const rows = [row({ index: 1 }), row({ index: 2, date: '2026-06-01', amount: 12 })];
    const flagged = flagDuplicates(rows, []);

    expect(flagged.map((r) => r.index)).toEqual([1, 2]);
    expect(flagged[1]).toMatchObject({ date: '2026-06-01', amount: 12, duplicate: null });
  });
});

describe('dateRangeOf', () => {
  it('widens the span by the dedup window on both sides', () => {
    const rows = [row({ index: 1, date: '2026-04-10' }), row({ index: 2, date: '2026-06-02' })];
    expect(dateRangeOf(rows)).toEqual({ from: '2026-04-09', to: '2026-06-03' });
  });

  it('returns null for no rows', () => {
    expect(dateRangeOf([])).toBeNull();
  });

  it('handles a month boundary', () => {
    expect(dateRangeOf([row({ index: 1, date: '2026-03-01' })])).toEqual({
      from: '2026-02-28',
      to: '2026-03-02',
    });
  });
});
