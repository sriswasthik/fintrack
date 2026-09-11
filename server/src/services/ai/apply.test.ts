import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../../generated/prisma/client';
import { CATEGORIES } from '../rules/categories';
import { DEFAULT_RULES } from '../rules/defaults';
import { matchRule, orderRules, type EngineRule } from '../rules/engine';
import { applyLlmCategorization } from './apply';
import { EVAL_SET } from './eval-set';
import type { CategorizationOutcome, MerchantCategorizer } from './categorize';

/** Answers from a fixed table; anything unknown comes back as an abstention. */
function scriptedCategorizer(
  answers: Record<string, { category: string; confidence: number }>,
): MerchantCategorizer & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    categorize: vi.fn(async (merchants: string[]): Promise<CategorizationOutcome[]> => {
      asked.push(merchants);
      return merchants.map((merchant) => {
        const answer = answers[merchant];
        return answer
          ? {
              merchant,
              category: answer.category as never,
              confidence: answer.confidence,
              reason: 'scripted',
            }
          : {
              merchant,
              category: 'UNCATEGORIZED' as never,
              confidence: 0,
              reason: 'unknown',
              rejected: true,
            };
      });
    }),
  };
}

const db = {
  transactionFindMany: vi.fn(),
  transactionUpdate: vi.fn(),
  cacheFindMany: vi.fn(),
  cacheUpsert: vi.fn(),
};

const prisma = {
  transaction: { findMany: db.transactionFindMany, update: db.transactionUpdate },
  merchantCategoryCache: { findMany: db.cacheFindMany, upsert: db.cacheUpsert },
} as unknown as PrismaClient;

function transactions(rows: [string, string][]) {
  return rows.map(([id, normalizedMerchant]) => ({ id, normalizedMerchant }));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.transactionFindMany.mockResolvedValue([]);
  db.cacheFindMany.mockResolvedValue([]);
  db.transactionUpdate.mockResolvedValue({});
  db.cacheUpsert.mockResolvedValue({});
});

describe('applyLlmCategorization', () => {
  it('only considers UNCATEGORIZED rows the rule engine produced', async () => {
    await applyLlmCategorization(prisma, {
      userId: 'user_1',
      categorizer: scriptedCategorizer({}),
    });

    expect(db.transactionFindMany.mock.calls[0][0].where).toMatchObject({
      account: { userId: 'user_1' },
      category: 'UNCATEGORIZED',
      source: 'RULE',
    });
  });

  it('asks about each distinct merchant once, not once per transaction', async () => {
    db.transactionFindMany.mockResolvedValue(
      transactions([
        ['t1', 'MUJI'],
        ['t2', 'MUJI'],
        ['t3', 'MUJI'],
        ['t4', 'TESCO'],
      ]),
    );
    const categorizer = scriptedCategorizer({
      MUJI: { category: 'SHOPPING', confidence: 0.9 },
      TESCO: { category: 'GROCERIES', confidence: 0.9 },
    });

    const summary = await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(categorizer.asked).toEqual([['MUJI', 'TESCO']]);
    expect(summary).toMatchObject({
      unresolved: 4,
      distinctMerchants: 2,
      sentToModel: 2,
      categorized: 4,
    });
  });

  it('answers from the cache without calling the model', async () => {
    db.transactionFindMany.mockResolvedValue(transactions([['t1', 'MUJI']]));
    db.cacheFindMany.mockResolvedValue([
      { normalizedMerchant: 'MUJI', category: 'SHOPPING', confidence: 0.88 },
    ]);
    const categorizer = scriptedCategorizer({});

    const summary = await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(categorizer.categorize).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fromCache: 1, sentToModel: 0, categorized: 1 });
    expect(db.transactionUpdate.mock.calls[0][0].data).toMatchObject({
      category: 'SHOPPING',
      confidence: 0.88,
      source: 'LLM',
    });
  });

  it('asks only about the merchants the cache does not cover', async () => {
    db.transactionFindMany.mockResolvedValue(
      transactions([
        ['t1', 'MUJI'],
        ['t2', 'TESCO'],
      ]),
    );
    db.cacheFindMany.mockResolvedValue([
      { normalizedMerchant: 'MUJI', category: 'SHOPPING', confidence: 0.9 },
    ]);
    const categorizer = scriptedCategorizer({ TESCO: { category: 'GROCERIES', confidence: 0.9 } });

    await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(categorizer.asked).toEqual([['TESCO']]);
  });

  it('writes every accepted answer to the cache so it is never asked twice', async () => {
    db.transactionFindMany.mockResolvedValue(transactions([['t1', 'MUJI']]));
    const categorizer = scriptedCategorizer({ MUJI: { category: 'SHOPPING', confidence: 0.77 } });

    await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(db.cacheUpsert).toHaveBeenCalledTimes(1);
    expect(db.cacheUpsert.mock.calls[0][0]).toMatchObject({
      where: { normalizedMerchant: 'MUJI' },
      create: { normalizedMerchant: 'MUJI', category: 'SHOPPING', confidence: 0.77 },
    });
  });

  it('can be told to ignore the cache and re-ask', async () => {
    db.transactionFindMany.mockResolvedValue(transactions([['t1', 'MUJI']]));
    db.cacheFindMany.mockResolvedValue([
      { normalizedMerchant: 'MUJI', category: 'DINING', confidence: 0.5 },
    ]);
    const categorizer = scriptedCategorizer({ MUJI: { category: 'SHOPPING', confidence: 0.9 } });

    await applyLlmCategorization(prisma, { userId: 'user_1', categorizer, ignoreCache: true });

    expect(db.cacheFindMany).not.toHaveBeenCalled();
    expect(categorizer.asked).toEqual([['MUJI']]);
  });

  it('writes nothing for a rejected answer, leaving it for a later run', async () => {
    db.transactionFindMany.mockResolvedValue(transactions([['t1', 'WWWSTORE']]));
    const categorizer = scriptedCategorizer({});

    const summary = await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(db.transactionUpdate).not.toHaveBeenCalled();
    expect(db.cacheUpsert).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ rejected: 1, categorized: 0, stillUnresolved: 1 });
  });

  it('stores a low-confidence answer but counts it for review', async () => {
    db.transactionFindMany.mockResolvedValue(transactions([['t1', 'THE HALL']]));
    const categorizer = scriptedCategorizer({
      'THE HALL': { category: 'DINING', confidence: 0.35 },
    });

    const summary = await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(summary).toMatchObject({ categorized: 1, lowConfidence: 1 });
    expect(db.transactionUpdate.mock.calls[0][0].data.confidence).toBe(0.35);
  });

  it('marks what it decided as LLM-sourced, never RULE or MANUAL', async () => {
    db.transactionFindMany.mockResolvedValue(transactions([['t1', 'MUJI']]));
    const categorizer = scriptedCategorizer({ MUJI: { category: 'SHOPPING', confidence: 0.9 } });

    await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(db.transactionUpdate.mock.calls[0][0].data.source).toBe('LLM');
  });

  it('does nothing when there is nothing unresolved', async () => {
    const categorizer = scriptedCategorizer({});
    const summary = await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(categorizer.categorize).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ unresolved: 0, categorized: 0, stillUnresolved: 0 });
  });

  it('accounts for every unresolved row: categorized plus still-unresolved', async () => {
    db.transactionFindMany.mockResolvedValue(
      transactions([
        ['t1', 'MUJI'],
        ['t2', 'WWWSTORE'],
        ['t3', 'TESCO'],
      ]),
    );
    const categorizer = scriptedCategorizer({
      MUJI: { category: 'SHOPPING', confidence: 0.9 },
      TESCO: { category: 'GROCERIES', confidence: 0.9 },
    });

    const summary = await applyLlmCategorization(prisma, { userId: 'user_1', categorizer });

    expect(summary.categorized + summary.stillUnresolved).toBe(summary.unresolved);
    expect(summary.stillUnresolved).toBe(1);
  });
});

describe('the hand-labeled eval set', () => {
  it('labels every case with a category in the taxonomy', () => {
    EVAL_SET.forEach((testCase) => expect(CATEGORIES).toContain(testCase.expected));
  });

  it('still contains the nine merchants the Phase 3 run could not resolve', () => {
    // Their `difficulty` has moved as the rule set grew — six of the nine have
    // a rule now — so this asserts they are still *in* the set rather than how
    // they are labeled. Dropping them would quietly make the eval easier.
    const merchants = EVAL_SET.map((c) => c.merchant);
    expect(merchants).toEqual(
      expect.arrayContaining([
        'BLUEBIRD BAKERY',
        'THE HALL',
        'RAMEN TATSU-YA',
        'ALLBIRDS',
        'TESCO',
        'MUJI',
        'EL CORTE INGLES',
        'SNCF',
        'TRENITALIA',
      ]),
    );
  });

  it('still leaves the model enough to do to be worth measuring', () => {
    const forModel = EVAL_SET.filter((c) => c.difficulty !== 'control');
    expect(forModel.length).toBeGreaterThanOrEqual(15);
  });

  it('has no duplicate merchants', () => {
    const merchants = EVAL_SET.map((c) => c.merchant);
    expect(new Set(merchants).size).toBe(merchants.length);
  });

  it('is big enough to be worth reporting a percentage from', () => {
    expect(EVAL_SET.length).toBeGreaterThanOrEqual(25);
  });

  // --- The half of the eval that needs no API key ----------------------
  // `npm run eval:categorize` scores the pipeline as it runs: rules first, the
  // model on what is left. Its rule half is deterministic, so it can be
  // asserted here and will fail the moment a rule change moves a merchant.

  const ordered: EngineRule[] = orderRules(
    DEFAULT_RULES.map((rule, i) => ({
      id: `builtin-${String(i).padStart(4, '0')}`,
      pattern: rule.pattern,
      category: rule.category,
      priority: rule.priority,
      userId: null,
      learnedFromOverride: false,
    })),
  );

  it('has a rule for every case labeled a control', () => {
    // A `control` that no rule matches is a label that has quietly gone stale,
    // and it reads as a stronger claim about the rule set than is true.
    const uncovered = EVAL_SET.filter(
      (c) => c.difficulty === 'control' && matchRule(c.merchant, ordered) === null,
    ).map((c) => c.merchant);
    expect(uncovered).toEqual([]);
  });

  it('has no rule for any case labeled unresolved', () => {
    const covered = EVAL_SET.filter(
      (c) => c.difficulty === 'unresolved' && matchRule(c.merchant, ordered) !== null,
    ).map((c) => c.merchant);
    expect(covered).toEqual([]);
  });

  it('gets every rule-settled case right', () => {
    // Precision, not coverage: a rule that fires and is wrong corrupts totals
    // silently, which is worse than the model never seeing the merchant.
    const wrong = EVAL_SET.map((c) => ({ c, rule: matchRule(c.merchant, ordered) }))
      .filter(({ c, rule }) => rule !== null && rule.category !== c.expected)
      .map(({ c, rule }) => `${c.merchant}: got ${rule!.category}, want ${c.expected}`);
    expect(wrong).toEqual([]);
  });

  it('leaves a payment to a person for a human rather than a rule', () => {
    // There is no honest category for "money to Ramesh". A rule that claimed
    // one would be inventing a purchase.
    ['RAMESH KUMAR', '9876543210', 'Q629384756', 'PAYTMQR2810'].forEach((merchant) => {
      expect(matchRule(merchant, ordered)).toBeNull();
    });
  });
});
