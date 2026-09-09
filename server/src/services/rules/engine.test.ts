import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES } from './defaults';
import {
  REFUND_DAY_WINDOW,
  TRANSFER_DAY_WINDOW,
  categorizeTransaction,
  findRefundLinks,
  findTransferPairs,
  matchRule,
  orderRules,
  runEngine,
  type EngineRule,
  type EngineTransaction,
} from './engine';

let ruleSeq = 0;
function rule(overrides: Partial<EngineRule> = {}): EngineRule {
  ruleSeq += 1;
  return {
    id: `rule_${String(ruleSeq).padStart(3, '0')}`,
    pattern: 'WHOLE FOODS',
    category: 'GROCERIES',
    priority: 300,
    userId: null,
    learnedFromOverride: false,
    ...overrides,
  };
}

function txn(overrides: Partial<EngineTransaction> & { id: string }): EngineTransaction {
  return {
    accountId: 'acct_credit',
    date: '2026-04-10',
    normalizedMerchant: 'WHOLE FOODS',
    amount: 64.18,
    category: 'UNCATEGORIZED',
    confidence: 0,
    source: 'RULE',
    ...overrides,
  };
}

describe('rule ordering and matching', () => {
  it("puts a user's learned rule ahead of every built-in", () => {
    const builtIn = rule({ pattern: 'CATERING', category: 'DINING', priority: 1 });
    const learned = rule({
      pattern: 'CATERING',
      category: 'BUSINESS',
      priority: 999,
      userId: 'user_1',
      learnedFromOverride: true,
    });

    const ordered = orderRules([builtIn, learned]);

    expect(ordered[0]).toBe(learned);
    expect(matchRule('CATERING CO', ordered)?.category).toBe('BUSINESS');
  });

  it('prefers the lower priority number among rules of the same kind', () => {
    const transfer = rule({ pattern: 'CARD PAYMENT', category: 'TRANSFER', priority: 150 });
    const shopping = rule({ pattern: 'PAYMENT', category: 'SHOPPING', priority: 300 });

    expect(matchRule('CHASE CARD PAYMENT', orderRules([shopping, transfer]))?.category).toBe(
      'TRANSFER',
    );
  });

  it('breaks a priority tie deterministically by rule id', () => {
    const a = rule({ id: 'rule_a', pattern: 'ACME', category: 'SHOPPING', priority: 200 });
    const b = rule({ id: 'rule_b', pattern: 'ACME', category: 'BUSINESS', priority: 200 });

    expect(matchRule('ACME', orderRules([b, a]))?.id).toBe('rule_a');
    expect(matchRule('ACME', orderRules([a, b]))?.id).toBe('rule_a');
  });

  it('matches case-insensitively', () => {
    expect(matchRule('whole foods', orderRules([rule()]))).not.toBeNull();
  });

  it('treats a pattern as a regular expression', () => {
    const anchored = rule({ pattern: '^TARGET$', category: 'SHOPPING' });
    const ordered = orderRules([anchored]);

    expect(matchRule('TARGET', ordered)).not.toBeNull();
    expect(matchRule('TARGET OPTICAL', ordered)).toBeNull();
  });

  it('ignores a rule whose pattern is not a valid regular expression', () => {
    const broken = rule({ pattern: '([unclosed', category: 'SHOPPING' });
    const good = rule({ pattern: 'WHOLE FOODS', category: 'GROCERIES' });

    expect(() => matchRule('WHOLE FOODS', orderRules([broken, good]))).not.toThrow();
    expect(matchRule('WHOLE FOODS', orderRules([broken, good]))?.category).toBe('GROCERIES');
  });
});

describe('categorizeTransaction', () => {
  it('applies the first matching rule with full confidence', () => {
    const result = categorizeTransaction(txn({ id: 't1' }), orderRules([rule()]));

    expect(result).toMatchObject({
      transactionId: 't1',
      category: 'GROCERIES',
      confidence: 1,
      source: 'RULE',
    });
    expect(result.reason).toMatch(/Built-in rule/);
  });

  it('leaves an unmatched transaction UNCATEGORIZED with zero confidence', () => {
    const result = categorizeTransaction(
      txn({ id: 't1', normalizedMerchant: 'SOME LOCAL PLACE' }),
      orderRules([rule()]),
    );

    expect(result).toMatchObject({ category: 'UNCATEGORIZED', confidence: 0 });
    expect(result.reason).toBe('No rule matched');
  });

  it('never overwrites a manual correction (§8 case 12)', () => {
    const manual = txn({
      id: 't1',
      normalizedMerchant: 'CATERING CO',
      category: 'BUSINESS',
      source: 'MANUAL',
    });
    const contradicting = orderRules([
      rule({ pattern: 'CATERING', category: 'DINING', priority: 1 }),
    ]);

    expect(categorizeTransaction(manual, contradicting)).toMatchObject({
      category: 'BUSINESS',
      source: 'MANUAL',
    });
  });

  it('reports a learned rule differently from a built-in', () => {
    const learned = rule({ userId: 'user_1', learnedFromOverride: true });
    expect(categorizeTransaction(txn({ id: 't1' }), orderRules([learned])).reason).toMatch(
      /Learned rule/,
    );
  });
});

describe('findTransferPairs (§8 case 1)', () => {
  const out = txn({
    id: 'out',
    accountId: 'acct_checking',
    amount: 1200,
    normalizedMerchant: 'CHASE CARD PAYMENT',
  });
  const inn = txn({
    id: 'in',
    accountId: 'acct_credit',
    amount: -1200,
    normalizedMerchant: 'CHASE CARD PAYMENT',
  });

  it('pairs equal and opposite amounts across two accounts', () => {
    expect(findTransferPairs([out, inn])).toEqual([{ outgoingId: 'out', incomingId: 'in' }]);
  });

  it.each([0, 1, 2])('pairs legs %i day(s) apart', (offset) => {
    const shifted = { ...inn, date: `2026-04-${String(10 + offset).padStart(2, '0')}` };
    expect(findTransferPairs([out, shifted])).toHaveLength(1);
  });

  it(`does not pair legs more than ${TRANSFER_DAY_WINDOW} days apart`, () => {
    expect(findTransferPairs([out, { ...inn, date: '2026-04-13' }])).toEqual([]);
  });

  it('does not pair two legs on the same account', () => {
    expect(findTransferPairs([out, { ...inn, accountId: 'acct_checking' }])).toEqual([]);
  });

  it('does not pair different amounts', () => {
    expect(findTransferPairs([out, { ...inn, amount: -1200.01 }])).toEqual([]);
  });

  it('does not pair two outgoing legs', () => {
    expect(findTransferPairs([out, { ...inn, id: 'out2', amount: 1200 }])).toEqual([]);
  });

  it('pairs a run of identical payments one-to-one rather than all to the first', () => {
    const transactions = [
      txn({ id: 'o1', accountId: 'a', amount: 500, date: '2026-04-01' }),
      txn({ id: 'o2', accountId: 'a', amount: 500, date: '2026-05-01' }),
      txn({ id: 'i1', accountId: 'b', amount: -500, date: '2026-04-01' }),
      txn({ id: 'i2', accountId: 'b', amount: -500, date: '2026-05-01' }),
    ];

    expect(findTransferPairs(transactions)).toEqual([
      { outgoingId: 'o1', incomingId: 'i1' },
      { outgoingId: 'o2', incomingId: 'i2' },
    ]);
  });

  it('uses each transaction at most once', () => {
    const transactions = [
      txn({ id: 'o1', accountId: 'a', amount: 500 }),
      txn({ id: 'o2', accountId: 'a', amount: 500 }),
      txn({ id: 'i1', accountId: 'b', amount: -500 }),
    ];

    const pairs = findTransferPairs(transactions);
    expect(pairs).toHaveLength(1);
    expect(new Set(pairs.flatMap((p) => [p.outgoingId, p.incomingId])).size).toBe(2);
  });

  it('compares amounts in whole cents rather than by float equality', () => {
    const a = txn({ id: 'o', accountId: 'a', amount: 0.1 + 0.2 });
    const b = txn({ id: 'i', accountId: 'b', amount: -0.3 });
    expect(findTransferPairs([a, b])).toHaveLength(1);
  });
});

describe('findRefundLinks (§8 case 2)', () => {
  const never = () => false;
  const purchase = txn({ id: 'p', amount: 128.9, date: '2026-03-06', normalizedMerchant: 'ZARA' });
  const refund = txn({ id: 'r', amount: -128.9, date: '2026-03-15', normalizedMerchant: 'ZARA' });

  it('links a refund back to the earlier purchase it offsets', () => {
    expect(findRefundLinks([purchase, refund], never)).toEqual([
      { purchaseId: 'p', refundId: 'r' },
    ]);
  });

  it('requires the purchase to come first', () => {
    expect(findRefundLinks([{ ...purchase, date: '2026-03-20' }, refund], never)).toEqual([]);
  });

  it('requires the same merchant', () => {
    expect(findRefundLinks([purchase, { ...refund, normalizedMerchant: 'NIKE' }], never)).toEqual(
      [],
    );
  });

  it('requires the same account — a return goes back to the card it was bought with', () => {
    expect(findRefundLinks([purchase, { ...refund, accountId: 'other' }], never)).toEqual([]);
  });

  it('requires the same magnitude', () => {
    expect(findRefundLinks([purchase, { ...refund, amount: -100 }], never)).toEqual([]);
  });

  it(`does not link across more than ${REFUND_DAY_WINDOW} days`, () => {
    expect(findRefundLinks([purchase, { ...refund, date: '2026-09-01' }], never)).toEqual([]);
  });

  it('skips anything already settled as a transfer (§8 case 9)', () => {
    // A person-to-person round trip: money sent, then paid back by the same
    // network days later. Same account, same merchant, opposite amounts — it
    // looks exactly like a return, and is not one.
    const sent = txn({ id: 'out', amount: 45, date: '2026-03-10', normalizedMerchant: 'VENMO' });
    const back = txn({ id: 'back', amount: -45, date: '2026-03-13', normalizedMerchant: 'VENMO' });
    const isTransfer = (id: string) => id === 'out' || id === 'back';

    expect(findRefundLinks([sent, back], isTransfer)).toEqual([]);
    // Without the guard it would be matched, which is the bug this test pins.
    expect(findRefundLinks([sent, back], never)).toHaveLength(1);
  });

  it('links each refund to a different purchase', () => {
    const transactions = [
      txn({ id: 'p1', amount: 50, date: '2026-03-01', normalizedMerchant: 'NIKE' }),
      txn({ id: 'p2', amount: 50, date: '2026-03-02', normalizedMerchant: 'NIKE' }),
      txn({ id: 'r1', amount: -50, date: '2026-03-10', normalizedMerchant: 'NIKE' }),
      txn({ id: 'r2', amount: -50, date: '2026-03-11', normalizedMerchant: 'NIKE' }),
    ];

    const links = findRefundLinks(transactions, never);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.purchaseId)).size).toBe(2);
  });
});

describe('runEngine', () => {
  const rules = orderRules([
    rule({ pattern: 'CARD PAYMENT', category: 'TRANSFER', priority: 150 }),
    rule({ pattern: '^ZARA$', category: 'SHOPPING', priority: 300 }),
    rule({ pattern: '^VENMO$', category: 'TRANSFER', priority: 150 }),
  ]);

  it('lets a transfer pair override whatever the rules decided', () => {
    const transactions = [
      txn({ id: 'o', accountId: 'a', amount: 500, normalizedMerchant: 'ZARA' }),
      txn({ id: 'i', accountId: 'b', amount: -500, normalizedMerchant: 'ZARA' }),
    ];

    const { results, transferPairs } = runEngine(transactions, rules);

    expect(transferPairs).toHaveLength(1);
    expect(results.map((r) => r.category)).toEqual(['TRANSFER', 'TRANSFER']);
    expect(results.find((r) => r.transactionId === 'o')?.transferPairId).toBe('i');
    // The link lives on one side only; the other is reachable through the relation.
    expect(results.find((r) => r.transactionId === 'i')?.transferPairId).toBeUndefined();
  });

  it('marks a refund REFUND and stores the link on the purchase', () => {
    const transactions = [
      txn({ id: 'p', amount: 128.9, date: '2026-03-06', normalizedMerchant: 'ZARA' }),
      txn({ id: 'r', amount: -128.9, date: '2026-03-15', normalizedMerchant: 'ZARA' }),
    ];

    const { results, refundLinks } = runEngine(transactions, rules);

    expect(refundLinks).toEqual([{ purchaseId: 'p', refundId: 'r' }]);
    expect(results.find((r) => r.transactionId === 'p')).toMatchObject({
      category: 'SHOPPING',
      linkedRefundId: 'r',
    });
    expect(results.find((r) => r.transactionId === 'r')?.category).toBe('REFUND');
  });

  it('does not read a person-to-person round trip as a refund', () => {
    const transactions = [
      txn({
        id: 'out',
        accountId: 'a',
        amount: 45,
        date: '2026-03-10',
        normalizedMerchant: 'VENMO',
      }),
      txn({
        id: 'back',
        accountId: 'a',
        amount: -45,
        date: '2026-03-13',
        normalizedMerchant: 'VENMO',
      }),
    ];

    const { results, refundLinks } = runEngine(transactions, rules);

    expect(refundLinks).toEqual([]);
    expect(results.map((r) => r.category)).toEqual(['TRANSFER', 'TRANSFER']);
  });

  it('leaves manual rows out of rule matching and out of pairing', () => {
    const transactions = [
      txn({
        id: 'm',
        accountId: 'a',
        amount: 500,
        category: 'BUSINESS',
        source: 'MANUAL',
        normalizedMerchant: 'ZARA',
      }),
      txn({ id: 'i', accountId: 'b', amount: -500, normalizedMerchant: 'ZARA' }),
    ];

    const { results, transferPairs } = runEngine(transactions, rules);

    expect(transferPairs).toEqual([]);
    expect(results.find((r) => r.transactionId === 'm')).toMatchObject({
      category: 'BUSINESS',
      source: 'MANUAL',
    });
  });

  it('keeps an existing AI categorization when no rule matches', () => {
    // The deterministic pass runs after every import. If a non-match reset an
    // LLM answer to UNCATEGORIZED, one import would undo the whole Phase 4 pass
    // and send every reviewed merchant back to the queue.
    const transactions = [
      txn({
        id: 'llm',
        normalizedMerchant: 'BLUEBIRD BAKERY',
        category: 'DINING',
        confidence: 0.55,
        source: 'LLM',
      }),
    ];

    const [result] = runEngine(transactions, rules).results;

    expect(result).toMatchObject({ category: 'DINING', confidence: 0.55, source: 'LLM' });
  });

  it('lets a newly learned rule take over from an AI answer', () => {
    const learned = orderRules([
      ...rules,
      rule({
        pattern: '^BLUEBIRD BAKERY$',
        category: 'GROCERIES',
        userId: 'user_1',
        learnedFromOverride: true,
      }),
    ]);
    const transactions = [
      txn({
        id: 'llm',
        normalizedMerchant: 'BLUEBIRD BAKERY',
        category: 'DINING',
        confidence: 0.55,
        source: 'LLM',
      }),
    ];

    expect(runEngine(transactions, learned).results[0]).toMatchObject({
      category: 'GROCERIES',
      confidence: 1,
      source: 'RULE',
    });
  });

  it('still resets a rule-sourced row that no longer matches anything', () => {
    const transactions = [
      txn({
        id: 'stale',
        normalizedMerchant: 'GONE',
        category: 'DINING',
        confidence: 1,
        source: 'RULE',
      }),
    ];

    expect(runEngine(transactions, rules).results[0]).toMatchObject({
      category: 'UNCATEGORIZED',
      confidence: 0,
    });
  });

  it('returns one result per input, in input order', () => {
    const transactions = [txn({ id: 'a' }), txn({ id: 'b' }), txn({ id: 'c' })];
    expect(runEngine(transactions, rules).results.map((r) => r.transactionId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('the built-in rule set', () => {
  it('compiles every pattern', () => {
    DEFAULT_RULES.forEach((r) => expect(() => new RegExp(r.pattern, 'i')).not.toThrow());
  });

  it('covers most of the taxonomy', () => {
    const categories = new Set(DEFAULT_RULES.map((r) => r.category));
    expect(categories.size).toBeGreaterThanOrEqual(16);
    // Nothing may claim these: they are decided by the shape of the data.
    expect(categories.has('REFUND')).toBe(false);
    expect(categories.has('UNCATEGORIZED')).toBe(false);
  });

  it('ranks card payments above merchant rules so a transfer is never spend', () => {
    const ordered = orderRules(
      DEFAULT_RULES.map((r, i) => ({
        id: `default_${String(i).padStart(3, '0')}`,
        userId: null,
        learnedFromOverride: false,
        ...r,
      })),
    );

    expect(matchRule('CHASE CARD PAYMENT', ordered)?.category).toBe('TRANSFER');
    expect(matchRule('VENMO', ordered)?.category).toBe('TRANSFER');
    expect(matchRule('ZELLE', ordered)?.category).toBe('TRANSFER');
  });

  it.each([
    ['WHOLE FOODS', 'GROCERIES'],
    ['STARBUCKS', 'DINING'],
    ['JOES COFFEE', 'DINING'],
    ['UBER', 'TRANSPORTATION'],
    ['NETFLIX', 'SUBSCRIPTIONS'],
    ['OAKWOOD PROPERTY MGMT', 'HOUSING'],
    ['LEMONADE INSURANCE', 'INSURANCE'],
    ['DELTA AIR LINES', 'TRAVEL'],
    ['FOREIGN TRANSACTION FEE', 'FEES_INTEREST'],
    ['NORTHWIND LABS', 'INCOME'],
  ])('categorizes %s as %s', (merchant, expected) => {
    const ordered = orderRules(
      DEFAULT_RULES.map((r, i) => ({
        id: `default_${String(i).padStart(3, '0')}`,
        userId: null,
        learnedFromOverride: false,
        ...r,
      })),
    );
    expect(matchRule(merchant, ordered)?.category).toBe(expected);
  });

  // Phase 8 added venue and cuisine keywords (BAKERY, RAMEN, ...), which moved
  // BLUEBIRD BAKERY and RAMEN TATSU-YA out of this list and into DINING. What
  // is left is genuinely undecidable from the string alone.
  it.each(['THE HALL', 'WWWSTORE', 'CATERING CO'])(
    'leaves the ambiguous merchant %s for the LLM fallback',
    (merchant) => {
      const ordered = orderRules(
        DEFAULT_RULES.map((r, i) => ({
          id: `default_${String(i).padStart(3, '0')}`,
          userId: null,
          learnedFromOverride: false,
          ...r,
        })),
      );
      expect(matchRule(merchant, ordered)).toBeNull();
    },
  );
});
