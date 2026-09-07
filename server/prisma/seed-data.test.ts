import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PENDING_FROM,
  REFERENCE_DATE,
  START_DATE,
  generateDataset,
  transactionsByEdgeCase,
  type EdgeCase,
} from './seed-data';
import { buildCsv, buildReadme, toCsvRows } from './test-data-files';

const testDataDir = path.resolve(__dirname, '..', '..', 'test-data');
const read = (file: string) => readFileSync(path.join(testDataDir, file), 'utf8');

const dataset = generateDataset();

describe('synthetic dataset', () => {
  it('is deterministic', () => {
    expect(generateDataset()).toEqual(dataset);
  });

  it('has 600-800 transactions spanning at least six months', () => {
    expect(dataset.length).toBeGreaterThanOrEqual(600);
    expect(dataset.length).toBeLessThanOrEqual(800);

    const months = new Set(dataset.map((t) => t.date.slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(6);
    expect(dataset[0].date).toBe(START_DATE);
    expect(dataset[dataset.length - 1].date).toBe(REFERENCE_DATE);
  });

  it('numbers rows contiguously in date order', () => {
    dataset.forEach((t, i) => expect(t.row).toBe(i + 1));
    const dates = dataset.map((t) => t.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('marks only the most recent transactions as pending', () => {
    dataset.forEach((t) => {
      if (t.date >= PENDING_FROM) expect(t.postedDate).toBeNull();
      else expect(t.postedDate).not.toBeNull();
    });
  });

  it('uses a debit-positive sign convention', () => {
    const income = dataset.filter((t) => t.expectedCategory === 'INCOME');
    const refunds = dataset.filter((t) => t.expectedCategory === 'REFUND');
    expect(income.length).toBeGreaterThan(0);
    expect(income.every((t) => t.amount < 0)).toBe(true);
    expect(refunds.every((t) => t.amount < 0)).toBe(true);
    expect(
      dataset.filter((t) => t.expectedCategory === 'GROCERIES').every((t) => t.amount > 0),
    ).toBe(true);
  });

  it('rounds every amount to whole cents', () => {
    dataset.forEach((t) => expect(Math.round(t.amount * 100)).toBeCloseTo(t.amount * 100, 6));
  });
});

describe('PROJECT_CONTEXT.md §8 edge case coverage', () => {
  const byCase = transactionsByEdgeCase(dataset);
  const count = (c: EdgeCase) => (byCase.get(c) ?? []).length;

  it.each([
    ['transfer-out', 5],
    ['transfer-in', 5],
    ['refund-original', 5],
    ['refund', 5],
    ['split-candidate', 5],
    ['subscription', 5],
    ['subscription-price-change', 5],
    ['duplicate-original', 5],
    ['duplicate-glitch', 5],
    ['legit-repeat', 5],
    ['pending', 5],
    ['fx-purchase', 5],
    ['fx-fee', 5],
    ['mangled-merchant', 5],
    ['p2p-out', 5],
    ['p2p-in', 5],
    ['variable-income', 5],
    ['large-one-off', 1],
    ['manual-override', 1],
    ['new-subscription', 1],
  ] satisfies [EdgeCase, number][])('has at least %i instances of %s', (edgeCase, minimum) => {
    expect(count(edgeCase as EdgeCase)).toBeGreaterThanOrEqual(minimum);
  });

  it('pairs every transfer, refund, FX fee, P2P payment and duplicate', () => {
    const paired = dataset.filter((t) => t.pairId);
    const groups = new Map<string, number>();
    paired.forEach((t) => groups.set(t.pairId!, (groups.get(t.pairId!) ?? 0) + 1));
    groups.forEach((n, id) => expect(`${id}:${n}`).toBe(`${id}:2`));
  });

  it('offsets each refund exactly against its original purchase', () => {
    const byPair = new Map<string, typeof dataset>();
    dataset
      .filter((t) => t.pairId?.startsWith('refund-'))
      .forEach((t) => byPair.set(t.pairId!, [...(byPair.get(t.pairId!) ?? []), t]));

    expect(byPair.size).toBeGreaterThanOrEqual(5);
    byPair.forEach(([original, refund]) => {
      expect(original.amount + refund.amount).toBe(0);
      expect(refund.normalizedMerchant).toBe(original.normalizedMerchant);
      expect(refund.date > original.date).toBe(true);
    });
  });

  it('makes glitch duplicates indistinguishable from their original by value', () => {
    const originals = byCase.get('duplicate-original') ?? [];
    const glitches = byCase.get('duplicate-glitch') ?? [];
    originals.forEach((original) => {
      const glitch = glitches.find((g) => g.pairId === original.pairId);
      expect(glitch).toBeDefined();
      expect(glitch!.date).toBe(original.date);
      expect(glitch!.amount).toBe(original.amount);
      expect(glitch!.description).toBe(original.description);
    });
  });

  it('splits sum to their parent transaction amount', () => {
    const candidates = byCase.get('split-candidate') ?? [];
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    candidates.forEach((t) => {
      const total = (t.intendedSplits ?? []).reduce((s, p) => s + p.amount, 0);
      expect(Math.round(total * 100)).toBe(Math.round(t.amount * 100));
      expect(new Set((t.intendedSplits ?? []).map((p) => p.category)).size).toBeGreaterThan(1);
    });
  });

  it('changes one subscription price partway through the window', () => {
    const rows = byCase.get('subscription-price-change') ?? [];
    const amounts = [...new Set(rows.map((t) => t.amount))];
    expect(amounts.length).toBe(2);
  });

  it('starts the new subscription after the window opens', () => {
    const rows = byCase.get('new-subscription') ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].date > START_DATE).toBe(true);
  });
});

describe('committed test-data files', () => {
  it('synthetic_transactions.csv matches the generator', () => {
    expect(read('synthetic_transactions.csv')).toBe(buildCsv(dataset));
  });

  it('README.md matches the generator', () => {
    expect(read('README.md')).toBe(buildReadme(dataset));
  });

  it('exports exactly the four generic bank-export columns', () => {
    const [header] = read('synthetic_transactions.csv').split('\r\n');
    expect(header).toBe('date,description,amount,account');
  });

  it('has one CSV data row per transaction', () => {
    const lines = read('synthetic_transactions.csv').trimEnd().split('\r\n');
    expect(lines.length - 1).toBe(dataset.length);
    expect(toCsvRows(dataset)).toHaveLength(dataset.length);
  });
});
