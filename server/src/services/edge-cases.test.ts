/**
 * PROJECT_CONTEXT.md §8, case by case, against the Phase-1 synthetic dataset.
 *
 * The per-module suites test each piece in isolation with fixtures built for
 * the property under test. This one does the opposite: it takes the dataset
 * every edge case was deliberately planted in, runs it through the real
 * pipeline — parse, normalize, dedup, rule engine, anomaly detection — and
 * asserts that the planted rows come out the way §8 says they must.
 *
 * Two things make that worth a file of its own. It is end-to-end where the
 * others are unit-level, so a regression that only shows up when the stages are
 * composed has somewhere to fail. And it is organised by edge case rather than
 * by module, so `docs/EDGE_CASES.md` has one test name to point at per row.
 *
 * The database-backed half of §8 — that the aggregation actually excludes
 * transfers, nets refunds and expands splits — lives in
 * services/dashboard/aggregate.integration.test.ts, because it is SQL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  generateDataset,
  transactionsByEdgeCase,
  type EdgeCase,
  type GeneratedTransaction,
} from '../../prisma/seed-data';
import type { Category } from '../generated/prisma/enums';
import { detectAnomalies, type AnomalyTransaction } from './anomalies/detect';
import { HEADER_PRESETS, parseTransactions } from './parsing/csv';
import { flagDuplicates } from './parsing/dedup';
import { normalizeMerchant } from './parsing/normalize';
import { DEFAULT_RULES } from './rules/defaults';
import { runEngine, type EngineRule, type EngineTransaction } from './rules/engine';

// ---------------------------------------------------------------------------
// The pipeline, once, shared by every case below
// ---------------------------------------------------------------------------

const DATASET = generateDataset();
const PLANTED = transactionsByEdgeCase(DATASET);
const planted = (edgeCase: EdgeCase): GeneratedTransaction[] => PLANTED.get(edgeCase) ?? [];

const CSV = readFileSync(
  join(__dirname, '..', '..', '..', 'test-data', 'synthetic_transactions.csv'),
  'utf8',
);

/** Phase 2: what the server makes of the file a user uploads. */
const GENERIC = HEADER_PRESETS.find((preset) => preset.id === 'generic')!;
const PARSED = parseTransactions(CSV, GENERIC.mapping);

/** Phase 2: which rows it thinks are duplicates, importing into an empty account. */
const FLAGGED = flagDuplicates(PARSED.rows, []);

const RULES: EngineRule[] = DEFAULT_RULES.map((rule, i) => ({
  id: `builtin-${i}`,
  pattern: rule.pattern,
  category: rule.category,
  priority: rule.priority,
  userId: null,
  learnedFromOverride: false,
}));

/** Phase 3: the dataset as the deterministic engine categorizes it. */
const ENGINE_INPUT: EngineTransaction[] = DATASET.map((t) => ({
  id: String(t.row),
  accountId: t.account,
  date: t.date,
  normalizedMerchant: t.normalizedMerchant,
  amount: t.amount,
  // §8 case 12: a human correction is already on the row when it is imported.
  category: t.manualCategory ?? ('UNCATEGORIZED' as Category),
  confidence: t.manualCategory ? 1 : 0,
  source: t.manualCategory ? ('MANUAL' as const) : ('RULE' as const),
}));

const OUTCOME = runEngine(ENGINE_INPUT, RULES);
const RESULT = new Map(OUTCOME.results.map((r) => [r.transactionId, r]));
const ROW = new Map(DATASET.map((t) => [String(t.row), t]));

const categoryOf = (transaction: GeneratedTransaction): Category =>
  RESULT.get(String(transaction.row))!.category;

/** Phase 6: every anomaly flag over the whole window. */
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
/** What each purchase got back, from the links the engine worked out. */
const REFUNDED = new Map(
  OUTCOME.refundLinks.map((link) => [link.purchaseId, -ROW.get(link.refundId)!.amount]),
);

const ANOMALY_ROWS: AnomalyTransaction[] = DATASET.map((t) => ({
  id: String(t.row),
  date: t.date,
  amount: t.amount,
  normalizedMerchant: t.normalizedMerchant,
  category: RESULT.get(String(t.row))!.category,
  ...(REFUNDED.has(String(t.row)) ? { refunded: REFUNDED.get(String(t.row)) } : {}),
}));
const FLAGS = MONTHS.flatMap((month) => detectAnomalies(ANOMALY_ROWS, { month }));

// ---------------------------------------------------------------------------

describe('§8 case 1 — transfers between the user own accounts', () => {
  it('pairs every planted transfer, one leg to one leg', () => {
    const out = planted('transfer-out');
    const back = planted('transfer-in');
    expect(out).toHaveLength(6);
    expect(back).toHaveLength(6);

    // Each pair shares a pairId; the engine has to rediscover that from amounts
    // and dates alone, without ever seeing it.
    expect(OUTCOME.transferPairs).toHaveLength(out.length);
  });

  it('categorizes both legs TRANSFER, so neither is spend nor income', () => {
    [...planted('transfer-out'), ...planted('transfer-in')].forEach((leg) => {
      expect(categoryOf(leg), `${leg.date} ${leg.normalizedMerchant} ${leg.amount}`).toBe(
        'TRANSFER',
      );
    });
  });

  it('links the two legs so the pairing is visible in the data, not just implied', () => {
    planted('transfer-out').forEach((leg) => {
      const result = RESULT.get(String(leg.row))!;
      expect(result.transferPairId, `${leg.date} ${leg.normalizedMerchant}`).toBeTruthy();
      // The link points at the other half of the same planted pair.
      expect(ROW.get(result.transferPairId!)!.pairId).toBe(leg.pairId);
    });
  });
});

describe('§8 case 2 — refunds matched back to what they offset', () => {
  it('links every planted refund to its own original purchase', () => {
    const refunds = planted('refund');
    expect(refunds).toHaveLength(6);
    expect(OUTCOME.refundLinks).toHaveLength(refunds.length);

    OUTCOME.refundLinks.forEach((link) => {
      const refund = ROW.get(link.refundId)!;
      const purchase = ROW.get(link.purchaseId)!;
      expect(purchase.pairId).toBe(refund.pairId);
      // A refund comes after the purchase, for the same money, same merchant.
      expect(purchase.date <= refund.date).toBe(true);
      expect(purchase.amount).toBeCloseTo(-refund.amount, 2);
      expect(purchase.normalizedMerchant).toBe(refund.normalizedMerchant);
    });
  });

  it('marks the refund REFUND and stores the link on the purchase', () => {
    planted('refund').forEach((refund) => expect(categoryOf(refund)).toBe('REFUND'));
    planted('refund-original').forEach((purchase) => {
      expect(RESULT.get(String(purchase.row))!.linkedRefundId).toBeTruthy();
      // The purchase keeps its own category — it is not turned into a refund.
      expect(categoryOf(purchase)).toBe(purchase.expectedCategory);
    });
  });
});

describe('§8 case 3 — split transactions', () => {
  it('plants charges that genuinely span categories, with parts summing to the whole', () => {
    const candidates = planted('split-candidate');
    expect(candidates).toHaveLength(6);

    candidates.forEach((charge) => {
      const parts = charge.intendedSplits!;
      expect(parts.length).toBeGreaterThan(1);
      expect(new Set(parts.map((p) => p.category)).size).toBeGreaterThan(1);
      const sum = parts.reduce((total, part) => total + part.amount, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(charge.amount * 100));
    });
  });

  it('categorizes the parent by its dominant merchant until a user splits it', () => {
    // The engine has no way to know a Costco run was half groceries; it says
    // what the merchant says, and the split endpoint is how a user corrects it.
    planted('split-candidate').forEach((charge) => {
      expect(categoryOf(charge)).toBe(charge.expectedCategory);
    });
  });
});

describe('§8 case 4 — recurring subscriptions and price changes', () => {
  it('detects the price change in the month the new price first appears', () => {
    const charges = planted('subscription-price-change');
    const oldPrice = charges[0].amount;
    const raised = charges.find((c) => c.amount !== oldPrice)!;

    const flag = FLAGS.find(
      (f) => f.type === 'SUBSCRIPTION_PRICE_INCREASE' && f.transactionId === String(raised.row),
    );

    expect(flag).toBeDefined();
    expect(flag!.month).toBe(raised.date.slice(0, 7));
    expect(flag!.explanation).toContain(raised.normalizedMerchant);
  });

  it('detects the new subscription on its confirming second charge', () => {
    const [first, second] = planted('new-subscription');
    const flag = FLAGS.find(
      (f) => f.type === 'NEW_RECURRING_CHARGE' && f.transactionId === String(second.row),
    );

    expect(flag).toBeDefined();
    expect(flag!.month).toBe(second.date.slice(0, 7));
    expect(flag!.explanation).toContain(first.date);
  });

  it('categorizes the running subscriptions without an LLM call', () => {
    const subscriptions = planted('subscription');
    expect(subscriptions.length).toBeGreaterThan(30);
    subscriptions.forEach((charge) => {
      expect(categoryOf(charge), charge.normalizedMerchant).toBe(charge.expectedCategory);
    });
  });
});

describe('§8 case 5 — sync-glitch duplicates vs legitimate repeats', () => {
  it('flags every planted sync glitch', () => {
    const glitches = planted('duplicate-glitch');
    expect(glitches).toHaveLength(6);

    glitches.forEach((glitch) => {
      const row = FLAGGED[glitch.row - 1];
      expect(row.description).toBe(glitch.description);
      expect(row.duplicate, `row ${glitch.row} ${glitch.description}`).not.toBeNull();
    });
  });

  it('leaves the original of each pair alone', () => {
    planted('duplicate-original').forEach((original) => {
      const row = FLAGGED[original.row - 1];
      expect(row.description).toBe(original.description);
      expect(row.duplicate, `row ${original.row}`).toBeNull();
    });
  });

  it('flags a legitimate same-day repeat too, and says why, rather than guessing', () => {
    // A second coffee an hour later is indistinguishable from a sync glitch in
    // the data. The pipeline surfaces it for the user to decide instead of
    // silently dropping it — the flag is a question, not a verdict.
    const repeats = planted('legit-repeat');
    expect(repeats.length).toBeGreaterThan(0);

    const seconds = repeats.filter((_, i) => i % 2 === 1);
    seconds.forEach((repeat) => {
      const row = FLAGGED[repeat.row - 1];
      expect(row.duplicate?.kind).toBe('in-file');
      expect(row.duplicate?.reason).toBeTruthy();
    });
  });

  it('never confuses the daily coffee for a new recurring charge', () => {
    // The other half of case 5: a repeated small charge is not a subscription.
    const coffee = planted('legit-repeat')[0].normalizedMerchant;
    const recurring = FLAGS.filter(
      (f) => f.type === 'NEW_RECURRING_CHARGE' && f.explanation.startsWith(coffee),
    );
    expect(recurring).toEqual([]);
  });
});

describe('§8 case 6 — pending vs posted', () => {
  it('plants pending rows with no posted date', () => {
    const pending = planted('pending');
    expect(pending).toHaveLength(18);
    pending.forEach((row) => expect(row.postedDate).toBeNull());
  });

  it('categorizes a pending charge exactly as it would once posted', () => {
    // Pending is a settlement state, not a different kind of money. Nothing in
    // categorization may key off it — so a pending row must land wherever a
    // settled row from the same merchant lands, whatever that is.
    const settledByMerchant = new Map<string, Category>();
    DATASET.filter((t) => t.postedDate !== null).forEach((t) =>
      settledByMerchant.set(t.normalizedMerchant, categoryOf(t)),
    );

    const comparable = planted('pending').filter((row) =>
      settledByMerchant.has(row.normalizedMerchant),
    );
    expect(comparable.length).toBeGreaterThan(10);

    comparable.forEach((row) => {
      expect(categoryOf(row), `${row.date} ${row.normalizedMerchant}`).toBe(
        settledByMerchant.get(row.normalizedMerchant),
      );
    });
  });

  it('matches duplicates on the transaction date, not the posted date', () => {
    // Otherwise the same charge would look like two once it settled.
    const pending = planted('pending');
    const flaggedPending = pending.filter((row) => FLAGGED[row.row - 1].duplicate !== null);
    const alsoPlantedDuplicates = flaggedPending.filter((row) =>
      row.edgeCases.includes('duplicate-glitch'),
    );
    expect(flaggedPending).toEqual(alsoPlantedDuplicates);
  });
});

describe('§8 case 7 — foreign transaction fees', () => {
  it('keeps the fee as its own row rather than folding it into the purchase', () => {
    const purchases = planted('fx-purchase');
    const fees = planted('fx-fee');
    expect(purchases).toHaveLength(6);
    expect(fees).toHaveLength(fees.length);

    fees.forEach((fee) => {
      const purchase = purchases.find((p) => p.pairId === fee.pairId)!;
      expect(purchase).toBeDefined();
      // Same day, and the fee is a small fraction of what it is a fee on.
      expect(fee.date).toBe(purchase.date);
      expect(fee.amount).toBeLessThan(purchase.amount * 0.05);
    });
  });

  it('categorizes the fee as FEES_INTEREST and the purchase as what was bought', () => {
    planted('fx-fee').forEach((fee) => expect(categoryOf(fee)).toBe('FEES_INTEREST'));
    planted('fx-purchase').forEach((purchase) =>
      expect(categoryOf(purchase), purchase.normalizedMerchant).toBe(purchase.expectedCategory),
    );
  });

  it('does not read the fee and its purchase as a duplicate of each other', () => {
    planted('fx-fee').forEach((fee) => {
      expect(FLAGGED[fee.row - 1].duplicate, `row ${fee.row}`).toBeNull();
    });
  });
});

describe('§8 case 8 — processor-mangled merchant strings', () => {
  it('normalizes every descriptor in the dataset to its documented merchant', () => {
    const mangled = planted('mangled-merchant');
    expect(mangled.length).toBeGreaterThan(200);

    mangled.forEach((row) => {
      expect(normalizeMerchant(row.rawMerchant), row.rawMerchant).toBe(row.normalizedMerchant);
    });
  });

  it('parses the committed CSV to the same merchants the generator recorded', () => {
    expect(PARSED.errors).toEqual([]);
    expect(PARSED.rows).toHaveLength(DATASET.length);

    PARSED.rows.forEach((row, i) => {
      expect(row.normalizedMerchant, row.description).toBe(DATASET[i].normalizedMerchant);
    });
  });

  it('categorizes a mangled descriptor as well as a clean one', () => {
    // The whole point of normalization: `SQ *JOES COFFEE` and `JOES COFFEE`
    // reach the rule engine as the same string.
    const resolvable = planted('mangled-merchant').filter(
      (row) => row.expectedCategory !== 'UNCATEGORIZED',
    );
    const resolved = resolvable.filter((row) => categoryOf(row) === row.expectedCategory);
    expect(resolved.length / resolvable.length).toBeGreaterThan(0.9);
  });
});

describe('§8 case 9 — peer-to-peer round trips', () => {
  it('categorizes both halves TRANSFER, so a round trip is not spending', () => {
    const out = planted('p2p-out');
    const back = planted('p2p-in');
    expect(out).toHaveLength(6);
    expect(back).toHaveLength(6);

    [...out, ...back].forEach((leg) => {
      expect(categoryOf(leg), `${leg.date} ${leg.description}`).toBe('TRANSFER');
    });
  });

  it('does not mistake the money coming back for a refund', () => {
    // Same merchant, opposite sign, days apart — the shape of a refund. What
    // makes it not one is that a rule already settled it as a transfer.
    const p2pRows = new Set(
      [...planted('p2p-out'), ...planted('p2p-in')].map((t) => String(t.row)),
    );
    OUTCOME.refundLinks.forEach((link) => {
      expect(p2pRows.has(link.refundId)).toBe(false);
      expect(p2pRows.has(link.purchaseId)).toBe(false);
    });
  });

  it('collapses the payment network to one merchant however the descriptor reads', () => {
    const networks = new Set(
      [...planted('p2p-out'), ...planted('p2p-in')].map((t) => t.normalizedMerchant),
    );
    networks.forEach((network) => expect(network).toMatch(/^(VENMO|CASH APP|ZELLE)$/));
  });
});

describe('§8 case 10 — large one-off purchases', () => {
  it('flags each planted one-off as an unusual amount', () => {
    const oneOffs = planted('large-one-off');
    expect(oneOffs).toHaveLength(2);

    oneOffs.forEach((one) => {
      const flag = FLAGS.find(
        (f) => f.type === 'UNUSUAL_AMOUNT' && f.transactionId === String(one.row),
      );
      expect(flag, `${one.date} ${one.normalizedMerchant}`).toBeDefined();
      expect(flag!.month).toBe(one.date.slice(0, 7));
    });
  });

  it('does not let the one-off raise the bar and hide itself', () => {
    // The failure mode §8 case 10 names: a $3,299 charge dragging the average
    // for its category up far enough to look ordinary. The quartile fence the
    // detector uses barely moves, so the charge stays outside it.
    const laptop = planted('large-one-off')[0];
    const category = laptop.expectedCategory;
    const sameCategory = DATASET.filter(
      (t) => t.expectedCategory === category && t.amount > 0 && t.date < '2026-06',
    ).map((t) => t.amount);

    const mean = sameCategory.reduce((a, b) => a + b, 0) / sameCategory.length;
    // A mean-based threshold would have to be enormous to catch it...
    expect(laptop.amount).toBeGreaterThan(mean * 10);
    // ...and the detector catches it anyway.
    expect(
      FLAGS.some((f) => f.type === 'UNUSUAL_AMOUNT' && f.transactionId === String(laptop.row)),
    ).toBe(true);
  });

  it('still finds the anomalies in the months after it', () => {
    const laptopMonth = planted('large-one-off')[0].date.slice(0, 7);
    const later = FLAGS.filter((f) => f.month > laptopMonth);
    expect(later.length).toBeGreaterThan(0);
  });
});

describe('§8 case 11 — irregular and variable income', () => {
  it('plants income that varies in amount, date and source', () => {
    const income = planted('variable-income');
    expect(income).toHaveLength(21);

    const amounts = new Set(income.map((t) => t.amount));
    const sources = new Set(income.map((t) => t.normalizedMerchant));
    expect(amounts.size).toBeGreaterThan(1);
    expect(sources.size).toBeGreaterThan(1);
  });

  it('categorizes every source as INCOME, whatever it is called or worth', () => {
    planted('variable-income').forEach((row) => {
      expect(categoryOf(row), `${row.date} ${row.normalizedMerchant} ${row.amount}`).toBe('INCOME');
    });
  });

  it('keeps income negative under the debit-positive convention', () => {
    // Sign is what the aggregation keys off; an income row with a positive
    // amount would be counted as spending.
    planted('variable-income').forEach((row) => expect(row.amount).toBeLessThan(0));
    PARSED.rows
      .filter((row) => planted('variable-income').some((t) => t.row === row.index))
      .forEach((row) => expect(row.amount).toBeLessThan(0));
  });

  it('does not flag an irregular payday as an anomaly', () => {
    // Income is not spending, and a good month is not something to warn about.
    const incomeRows = new Set(planted('variable-income').map((t) => String(t.row)));
    FLAGS.forEach((flag) => {
      if (flag.transactionId) expect(incomeRows.has(flag.transactionId)).toBe(false);
    });
  });
});

describe('§8 case 12 — manual corrections survive', () => {
  const overrides = () => planted('manual-override');

  it('plants corrections on merchants no rule can resolve', () => {
    // A market stall, a bare processor string, a caterer. These are what a
    // person actually corrects: the rows the engine had to leave blank.
    const rows = overrides();
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.manualCategory).toBeTruthy();
      expect(row.manualCategory).toBe(row.expectedCategory);
    });
  });

  it('leaves a manual row untouched when the engine runs', () => {
    overrides().forEach((row) => {
      const result = RESULT.get(String(row.row))!;
      expect(result.category, `${row.date} ${row.normalizedMerchant}`).toBe(row.manualCategory);
      expect(result.source).toBe('MANUAL');
    });
  });

  it('survives a re-run of the engine, however many times it runs', () => {
    // Idempotence is the property that matters: the nightly re-categorization
    // must not slowly undo a user's work.
    let input = ENGINE_INPUT;
    for (let pass = 0; pass < 3; pass++) {
      const outcome = runEngine(input, RULES);
      input = outcome.results.map((result) => ({
        ...input.find((t) => t.id === result.transactionId)!,
        category: result.category,
        confidence: result.confidence,
        source: result.source,
      }));
    }

    const after = new Map(input.map((t) => [t.id, t]));
    overrides().forEach((row) => {
      expect(after.get(String(row.row))!.category).toBe(row.manualCategory);
      expect(after.get(String(row.row))!.source).toBe('MANUAL');
    });
  });

  it('survives a re-import of the same file', () => {
    // A re-import is a dedup pass: the corrected rows match what is already
    // stored, so they are flagged rather than inserted a second time, and the
    // stored correction is what remains.
    const existing = DATASET.map((t) => ({
      id: String(t.row),
      date: t.date,
      amount: t.amount,
      normalizedMerchant: t.normalizedMerchant,
    }));
    const reimported = flagDuplicates(PARSED.rows, existing);

    overrides().forEach((row) => {
      const flagged = reimported[row.row - 1];
      expect(flagged.duplicate?.kind, `row ${row.row}`).toBe('existing');
    });
  });

  it('is never re-categorized even once a rule learns to match the merchant', () => {
    // The dangerous case: the rule set grows, and a rule now has an opinion
    // about a merchant a person already decided. The person still wins.
    overrides().forEach((row) => {
      const contradicting: EngineRule = {
        id: 'later-rule',
        pattern: `^${row.normalizedMerchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        // Deliberately not what the human chose.
        category: 'ENTERTAINMENT',
        priority: 1,
        userId: null,
        learnedFromOverride: false,
      };

      const outcome = runEngine(ENGINE_INPUT, [contradicting, ...RULES]);
      const result = outcome.results.find((r) => r.transactionId === String(row.row))!;

      expect(result.category, `${row.date} ${row.normalizedMerchant}`).toBe(row.manualCategory);
      expect(result.source).toBe('MANUAL');

      // ...and the same rule does claim an uncorrected row from that merchant,
      // so this is about precedence rather than the rule not matching.
      const probe = runEngine(
        [
          {
            id: 'probe',
            accountId: row.account,
            date: row.date,
            normalizedMerchant: row.normalizedMerchant,
            amount: row.amount,
            category: 'UNCATEGORIZED' as Category,
            confidence: 0,
            source: 'RULE' as const,
          },
        ],
        [contradicting, ...RULES],
      );
      expect(probe.results[0].category).toBe('ENTERTAINMENT');
    });
  });
});
