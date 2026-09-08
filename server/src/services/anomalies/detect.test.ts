import { describe, expect, it } from 'vitest';

import {
  generateDataset,
  transactionsByEdgeCase,
  type GeneratedTransaction,
} from '../../../prisma/seed-data';
import type { Category } from '../../generated/prisma/enums';
import {
  DEFAULTS,
  detectAmountOutliers,
  detectAnomalies,
  detectCategorySpikes,
  detectNewRecurringCharges,
  detectSubscriptionPriceIncreases,
  findRecurringCharges,
  trailingMonths,
  type AnomalyTransaction,
  type DetectedAnomaly,
} from './detect';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The Phase-1 dataset, shaped the way services/anomalies/apply.ts shapes rows
 * read from the database: categorized, with each refund attributed to the
 * purchase it offsets so it nets against that category instead of sitting in a
 * bucket of its own.
 *
 * Running against the generator rather than a hand-copied fixture means these
 * tests assert against the anomalies that were actually planted — if the seed
 * changes, they fail rather than quietly testing a stale copy.
 */
function seededTransactions(): AnomalyTransaction[] {
  const dataset = generateDataset();
  const purchaseCategory = new Map<string, Category>();
  dataset.forEach((t) => {
    if (t.edgeCases.includes('refund-original') && t.pairId) {
      purchaseCategory.set(t.pairId, t.manualCategory ?? t.expectedCategory);
    }
  });

  return dataset.map((t) => ({
    id: String(t.row),
    date: t.date,
    amount: t.amount,
    normalizedMerchant: t.normalizedMerchant,
    category:
      t.expectedCategory === 'REFUND' && t.pairId && purchaseCategory.has(t.pairId)
        ? purchaseCategory.get(t.pairId)!
        : (t.manualCategory ?? t.expectedCategory),
  }));
}

const SEEDED = seededTransactions();
const PLANTED = transactionsByEdgeCase(generateDataset());
const SEEDED_MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

/** Every flag the detectors raise across the whole seeded window. */
const ALL_SEEDED_FLAGS: DetectedAnomaly[] = SEEDED_MONTHS.flatMap((month) =>
  detectAnomalies(SEEDED, { month }),
);

const planted = (edgeCase: Parameters<typeof PLANTED.get>[0]): GeneratedTransaction[] =>
  PLANTED.get(edgeCase) ?? [];

/** A minimal transaction, for the hand-built fixtures below. */
function tx(
  date: string,
  merchant: string,
  amount: number,
  category: Category = 'SHOPPING',
): AnomalyTransaction {
  return {
    id: `${merchant}-${date}-${amount}`,
    date,
    amount,
    category,
    normalizedMerchant: merchant,
  };
}

/** `count` charges on the same day of successive months. */
function monthly(
  merchant: string,
  amount: number,
  from: string,
  count: number,
  category: Category = 'SUBSCRIPTIONS',
): AnomalyTransaction[] {
  const [year, month, day] = from.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1 + i, day)).toISOString().slice(0, 10);
    return tx(date, merchant, amount, category);
  });
}

// ---------------------------------------------------------------------------
// The anomalies planted in the Phase-1 seed
// ---------------------------------------------------------------------------

describe('the anomalies planted in the seed data', () => {
  it('finds the large one-off purchases', () => {
    const oneOffs = planted('large-one-off');
    expect(oneOffs).toHaveLength(2);

    oneOffs.forEach((one) => {
      const month = one.date.slice(0, 7);
      const flags = detectAmountOutliers(SEEDED, { month }).filter(
        (flag) => flag.transactionId === String(one.row),
      );

      expect(flags, `${one.normalizedMerchant} ${one.date}`).toHaveLength(1);
      expect(flags[0].type).toBe('UNUSUAL_AMOUNT');
      expect(flags[0].explanation).toContain(one.normalizedMerchant);
      expect(flags[0].explanation).toContain(one.expectedCategory);
    });
  });

  it('rates the $3,299 laptop more severely than the $1,842 flight', () => {
    const [laptop, flight] = planted('large-one-off');
    const laptopFlag = detectAmountOutliers(SEEDED, { month: laptop.date.slice(0, 7) }).find(
      (f) => f.transactionId === String(laptop.row),
    );
    const flightFlag = detectAmountOutliers(SEEDED, { month: flight.date.slice(0, 7) }).find(
      (f) => f.transactionId === String(flight.row),
    );

    expect(laptopFlag?.severity).toBe('HIGH');
    expect(flightFlag?.severity).toBe('MEDIUM');
  });

  it('finds the subscription price change, in the month the new price appears', () => {
    const charges = planted('subscription-price-change');
    const before = charges[0].amount;
    const after = charges.find((c) => c.amount !== before)!;

    const flags = detectSubscriptionPriceIncreases(SEEDED, { month: after.date.slice(0, 7) });
    const netflix = flags.filter((f) => f.explanation.startsWith(after.normalizedMerchant));

    expect(netflix).toHaveLength(1);
    expect(netflix[0].type).toBe('SUBSCRIPTION_PRICE_INCREASE');
    expect(netflix[0].transactionId).toBe(String(after.row));
    expect(netflix[0].explanation).toContain('$15.49');
    expect(netflix[0].explanation).toContain('$17.99');
  });

  it('does not repeat the price change in the months that follow it', () => {
    const charges = planted('subscription-price-change');
    const merchant = charges[0].normalizedMerchant;
    const changeMonth = charges.find((c) => c.amount !== charges[0].amount)!.date.slice(0, 7);

    const later = SEEDED_MONTHS.filter((m) => m > changeMonth).flatMap((month) =>
      detectSubscriptionPriceIncreases(SEEDED, { month }).filter((f) =>
        f.explanation.startsWith(merchant),
      ),
    );

    expect(later).toEqual([]);
  });

  it('finds the new subscription, on its second charge rather than its first', () => {
    const [first, second] = planted('new-subscription');
    const merchant = first.normalizedMerchant;

    const onFirst = detectNewRecurringCharges(SEEDED, { month: first.date.slice(0, 7) }).filter(
      (f) => f.explanation.startsWith(merchant),
    );
    const onSecond = detectNewRecurringCharges(SEEDED, { month: second.date.slice(0, 7) }).filter(
      (f) => f.explanation.startsWith(merchant),
    );

    expect(onFirst).toEqual([]);
    expect(onSecond).toHaveLength(1);
    expect(onSecond[0].type).toBe('NEW_RECURRING_CHARGE');
    expect(onSecond[0].transactionId).toBe(String(second.row));
    expect(onSecond[0].explanation).toContain(first.date);
  });

  it('finds the category spike the large one-off causes', () => {
    const laptop = planted('large-one-off')[0];
    const month = laptop.date.slice(0, 7);

    const spikes = detectCategorySpikes(SEEDED, { month });
    const shopping = spikes.filter((f) => f.explanation.startsWith(laptop.expectedCategory));

    expect(shopping).toHaveLength(1);
    expect(shopping[0].type).toBe('CATEGORY_SPEND_SPIKE');
    expect(shopping[0].severity).toBe('HIGH');
    expect(shopping[0].transactionId).toBeUndefined();
  });

  it('accounts for every planted anomaly across the whole window', () => {
    const summary = ALL_SEEDED_FLAGS.map((f) => `${f.month} ${f.type} ${f.explanation}`);

    const planted = [
      /2026-05 UNUSUAL_AMOUNT \$3,299\.00 at APPLE STORE/,
      /2026-07 UNUSUAL_AMOUNT \$1,842\.60 at DELTA AIR LINES/,
      /2026-06 SUBSCRIPTION_PRICE_INCREASE NETFLIX went up from \$15\.49 to \$17\.99/,
      /2026-08 NEW_RECURRING_CHARGE DISNEY PLUS looks like a new recurring charge/,
      /2026-05 CATEGORY_SPEND_SPIKE SHOPPING came to/,
    ];

    planted.forEach((pattern) => {
      expect(
        summary.some((line) => pattern.test(line)),
        String(pattern),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Not crying wolf
// ---------------------------------------------------------------------------

describe('false positives', () => {
  it('does not flag the daily coffee as a new recurring charge', () => {
    const coffee = planted('legit-repeat')[0].normalizedMerchant;
    const charges = SEEDED.filter((t) => t.normalizedMerchant === coffee);

    // The premise: this merchant appears often, in small similar amounts, over
    // months — which is exactly what a subscription looks like from far enough
    // away. It is a habit, not a plan, and must never be flagged as one.
    expect(charges.length).toBeGreaterThan(20);
    expect(Math.max(...charges.map((c) => c.amount))).toBeLessThan(10);

    const flags = SEEDED_MONTHS.flatMap((month) => detectNewRecurringCharges(SEEDED, { month }));
    expect(flags.filter((f) => f.explanation.startsWith(coffee))).toEqual([]);
  });

  it('does not read the daily coffee as a subscription that changed price either', () => {
    const coffee = planted('legit-repeat')[0].normalizedMerchant;
    const flags = SEEDED_MONTHS.flatMap((month) =>
      detectSubscriptionPriceIncreases(SEEDED, { month }),
    );

    expect(flags.filter((f) => f.explanation.startsWith(coffee))).toEqual([]);
  });

  it('never treats a merchant billed twice in a month as recurring', () => {
    const recurring = SEEDED_MONTHS.flatMap((month) =>
      findRecurringCharges(SEEDED, { month }).map((charge) => ({ month, ...charge })),
    );

    recurring.forEach(({ month, merchant }) => {
      const perMonth = new Map<string, number>();
      SEEDED.filter((t) => t.normalizedMerchant === merchant)
        .filter((t) => trailingMonths(month, DEFAULTS.lookbackMonths).includes(t.date.slice(0, 7)))
        .forEach((t) => {
          const key = t.date.slice(0, 7);
          perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
        });

      expect(Math.max(...perMonth.values()), merchant).toBeLessThanOrEqual(1);
    });
  });

  it('does not call an existing subscription new just because the import starts there', () => {
    // Every subscription in the seed is already running on day one. None of them
    // is new; there is simply no history in front of them.
    const arrivedLater = new Set(planted('new-subscription').map((t) => t.normalizedMerchant));
    const subscriptions = new Set(
      planted('subscription')
        .map((t) => t.normalizedMerchant)
        .filter((merchant) => !arrivedLater.has(merchant)),
    );
    expect(subscriptions.size).toBeGreaterThan(3);

    const newlyFlagged = ALL_SEEDED_FLAGS.filter((f) => f.type === 'NEW_RECURRING_CHARGE').map(
      (f) => f.explanation.split(' looks like')[0],
    );

    newlyFlagged.forEach((merchant) => {
      expect(subscriptions.has(merchant), `${merchant} was already running`).toBe(false);
    });
  });

  it('separates the monthly bills from everyday spending exactly', () => {
    // Every merchant the generator bills on a fixed day of the month, listed
    // here rather than derived so that a change to the seed fails this test
    // instead of quietly moving the goalposts.
    const monthlyBills = [
      'ADOBE',
      'AMAZON PRIME',
      'APPLE ICLOUD',
      'DISNEY PLUS',
      'LEMONADE INSURANCE',
      'MINT MOBILE',
      'NETFLIX',
      'NEW YORK TIMES',
      'OAKWOOD PROPERTY MGMT',
      'PGE',
      'PLANET FITNESS',
      'SONIC FIBER',
      'SPOTIFY',
    ];

    const classified = new Set(
      SEEDED_MONTHS.flatMap((month) =>
        findRecurringCharges(SEEDED, { month }).map((charge) => charge.merchant),
      ),
    );

    // Nothing missed...
    expect([...classified].sort()).toEqual(monthlyBills);

    // ...and nothing else swept up. 63 everyday merchants, none of them called
    // a subscription.
    const everyday = [
      ...new Set(SEEDED.map((t) => t.normalizedMerchant).filter((m) => !monthlyBills.includes(m))),
    ];
    expect(everyday.length).toBeGreaterThan(50);
    expect(everyday.filter((merchant) => classified.has(merchant))).toEqual([]);
  });

  it('produces a handful of insights over six months, not a wall of them', () => {
    // A panel nobody reads is worse than no panel. 700 transactions across six
    // months should yield single digits, and every one of them should be a
    // finding a person would act on.
    expect(SEEDED).toHaveLength(704);
    expect(ALL_SEEDED_FLAGS.length).toBeLessThanOrEqual(12);
    expect(ALL_SEEDED_FLAGS.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// The detectors, on their own terms
// ---------------------------------------------------------------------------

describe('trailingMonths', () => {
  it('returns the window ending at the month asked for, oldest first', () => {
    expect(trailingMonths('2026-06', 4)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
  });

  it('crosses a year boundary', () => {
    expect(trailingMonths('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });
});

describe('detectAmountOutliers', () => {
  const ordinary = (day: number, amount: number) =>
    tx(`2026-06-${String(day).padStart(2, '0')}`, `SHOP ${day}`, amount, 'DINING');

  const dining = [
    ...Array.from({ length: 10 }, (_, i) => ordinary(i + 1, 20 + i)),
    ...Array.from({ length: 10 }, (_, i) =>
      tx(`2026-05-${String(i + 1).padStart(2, '0')}`, `M${i}`, 22 + i, 'DINING'),
    ),
  ];

  it('flags a charge outside its own category-s fence', () => {
    const flags = detectAmountOutliers([...dining, ordinary(20, 400)], { month: '2026-06' });
    expect(flags).toHaveLength(1);
    expect(flags[0].explanation).toContain('unusually large for DINING');
  });

  it('says nothing about a category with too little history to have a shape', () => {
    const thin = [tx('2026-06-01', 'A', 10, 'EDUCATION'), tx('2026-06-02', 'B', 900, 'EDUCATION')];
    expect(detectAmountOutliers(thin, { month: '2026-06' })).toEqual([]);
  });

  it('holds its fire on small amounts, however unusual the category finds them', () => {
    const pennies = Array.from({ length: 12 }, (_, i) =>
      tx(`2026-06-${String(i + 1).padStart(2, '0')}`, `M${i}`, 1, 'DINING'),
    );
    const flags = detectAmountOutliers([...pennies, ordinary(20, 30)], { month: '2026-06' });
    expect(flags).toEqual([]);
  });

  it('only reports charges in the month asked about', () => {
    const withOutlier = [...dining, tx('2026-05-20', 'BIG', 400, 'DINING')];
    expect(detectAmountOutliers(withOutlier, { month: '2026-06' })).toEqual([]);
    expect(detectAmountOutliers(withOutlier, { month: '2026-05' })).toHaveLength(1);
  });

  it('ignores income, transfers and the uncategorized queue', () => {
    const noise = [
      ...dining,
      tx('2026-06-20', 'PAYROLL', -9000, 'INCOME'),
      tx('2026-06-21', 'SAVINGS', 5000, 'TRANSFER'),
      tx('2026-06-22', 'MYSTERY', 5000, 'UNCATEGORIZED'),
    ];
    expect(detectAmountOutliers(noise, { month: '2026-06' })).toEqual([]);
  });
});

describe('findRecurringCharges', () => {
  it('finds a merchant billing on the same day each month', () => {
    const found = findRecurringCharges(monthly('SPOTIFY', 11.99, '2026-04-09', 3), {
      month: '2026-06',
    });
    expect(found.map((c) => c.merchant)).toEqual(['SPOTIFY']);
    expect(found[0].occurrences).toHaveLength(3);
  });

  it('rejects a merchant charged several times in a month, however even the spacing', () => {
    // Two coffees a month, 30 days apart, at the same price: monthly by every
    // test except the one that matters.
    const coffee = [
      ...monthly('JOES COFFEE', 5.25, '2026-04-02', 3, 'DINING'),
      ...monthly('JOES COFFEE', 5.25, '2026-04-16', 3, 'DINING'),
    ];
    expect(findRecurringCharges(coffee, { month: '2026-06' })).toEqual([]);
  });

  it('breaks the run when the amount moves beyond tolerance', () => {
    const wobbly = [
      ...monthly('PGE', 60, '2026-03-04', 2, 'UTILITIES'),
      ...monthly('PGE', 200, '2026-05-04', 2, 'UTILITIES'),
    ];
    const found = findRecurringCharges(wobbly, { month: '2026-06' });
    expect(found[0].occurrences).toHaveLength(2);
  });

  it('breaks the run on a missed month, and keeps the more recent side', () => {
    const gappy = [...monthly('GYM', 45, '2026-03-01', 2), ...monthly('GYM', 45, '2026-06-01', 2)];
    const found = findRecurringCharges(gappy, { month: '2026-07' });
    expect(found[0].occurrences).toHaveLength(2);
    expect(found[0].occurrences[0].date).toBe('2026-06-01');
  });
});

describe('detectNewRecurringCharges', () => {
  const history = Array.from({ length: 6 }, (_, i) =>
    tx(`2026-0${i + 1}-05`, `SHOP ${i}`, 30, 'GROCERIES'),
  );

  it('flags on the confirming second charge', () => {
    const rows = [...history, ...monthly('DISNEY PLUS', 13.99, '2026-05-14', 2)];
    expect(detectNewRecurringCharges(rows, { month: '2026-05' })).toEqual([]);

    const flags = detectNewRecurringCharges(rows, { month: '2026-06' });
    expect(flags).toHaveLength(1);
    expect(flags[0].explanation).toContain('DISNEY PLUS');
  });

  it('says nothing when the merchant was already billing before the run', () => {
    const rows = [
      ...history,
      tx('2026-02-14', 'DISNEY PLUS', 9.99, 'SUBSCRIPTIONS'),
      ...monthly('DISNEY PLUS', 13.99, '2026-05-14', 2),
    ];
    expect(detectNewRecurringCharges(rows, { month: '2026-06' })).toEqual([]);
  });

  it('will not call something new when there is no history to have missed it in', () => {
    const rows = monthly('DISNEY PLUS', 13.99, '2026-05-14', 2);
    expect(detectNewRecurringCharges(rows, { month: '2026-06' })).toEqual([]);
  });

  it('scales severity with what the subscription costs', () => {
    const cheap = [...history, ...monthly('ICLOUD', 2.99, '2026-05-06', 2)];
    const dear = [...history, ...monthly('GYM', 120, '2026-05-06', 2)];

    expect(detectNewRecurringCharges(cheap, { month: '2026-06' })[0].severity).toBe('LOW');
    expect(detectNewRecurringCharges(dear, { month: '2026-06' })[0].severity).toBe('HIGH');
  });
});

describe('detectSubscriptionPriceIncreases', () => {
  const raised = (from: number, to: number) => [
    ...monthly('NETFLIX', from, '2026-03-17', 3),
    ...monthly('NETFLIX', to, '2026-06-17', 1),
  ];

  it('flags a rise once the old price was settled', () => {
    const flags = detectSubscriptionPriceIncreases(raised(15.49, 17.99), { month: '2026-06' });
    expect(flags).toHaveLength(1);
    expect(flags[0].explanation).toContain('+16%');
    expect(flags[0].explanation).toContain('$30.00 a year');
  });

  it('ignores a fall', () => {
    expect(detectSubscriptionPriceIncreases(raised(17.99, 15.49), { month: '2026-06' })).toEqual(
      [],
    );
  });

  it('ignores a rise too small to be worth telling anyone about', () => {
    expect(detectSubscriptionPriceIncreases(raised(2.99, 3.15), { month: '2026-06' })).toEqual([]);
  });

  it('will not call a bill that is different every month a price change', () => {
    // A utility that has never had a settled price cannot have had it raised.
    const utility = [
      tx('2026-03-04', 'PGE', 88.12, 'UTILITIES'),
      tx('2026-04-04', 'PGE', 71.4, 'UTILITIES'),
      tx('2026-05-04', 'PGE', 101.03, 'UTILITIES'),
      tx('2026-06-04', 'PGE', 118.97, 'UTILITIES'),
    ];
    expect(detectSubscriptionPriceIncreases(utility, { month: '2026-06' })).toEqual([]);
  });
});

describe('detectCategorySpikes', () => {
  const monthOfSpending = (month: string, total: number, category: Category = 'SHOPPING') =>
    Array.from({ length: 4 }, (_, i) => tx(`${month}-0${i + 1}`, `SHOP ${i}`, total / 4, category));

  it('flags a month well above its own baseline', () => {
    const rows = [
      ...monthOfSpending('2026-03', 400),
      ...monthOfSpending('2026-04', 440),
      ...monthOfSpending('2026-05', 1600),
    ];
    const flags = detectCategorySpikes(rows, { month: '2026-05' });
    expect(flags).toHaveLength(1);
    expect(flags[0].explanation).toContain('SHOPPING came to $1,600.00');
  });

  it('needs a baseline before it will claim anything', () => {
    const rows = [...monthOfSpending('2026-04', 400), ...monthOfSpending('2026-05', 1600)];
    expect(detectCategorySpikes(rows, { month: '2026-05' })).toEqual([]);
  });

  it('holds its fire when the jump is large in ratio but small in money', () => {
    const rows = [
      ...monthOfSpending('2026-03', 20, 'PERSONAL_CARE'),
      ...monthOfSpending('2026-04', 24, 'PERSONAL_CARE'),
      ...monthOfSpending('2026-05', 96, 'PERSONAL_CARE'),
    ];
    expect(detectCategorySpikes(rows, { month: '2026-05' })).toEqual([]);
  });

  it('uses a median baseline, so one huge month cannot hide the next', () => {
    const rows = [
      ...monthOfSpending('2026-02', 400),
      ...monthOfSpending('2026-03', 420),
      ...monthOfSpending('2026-04', 440),
      ...monthOfSpending('2026-05', 6000),
      ...monthOfSpending('2026-06', 1400),
    ];

    // A mean baseline would be ~1815 and June would look like a quiet month.
    expect(detectCategorySpikes(rows, { month: '2026-06' })).toHaveLength(1);
  });

  it('nets a refund against the category it was attributed to', () => {
    const rows = [
      ...monthOfSpending('2026-03', 400),
      ...monthOfSpending('2026-04', 440),
      ...monthOfSpending('2026-05', 1600),
      tx('2026-05-20', 'WAYFAIR', -1000, 'SHOPPING'),
    ];
    expect(detectCategorySpikes(rows, { month: '2026-05' })).toEqual([]);
  });
});

describe('detectAnomalies', () => {
  it('is deterministic — the same data gives byte-identical findings', () => {
    const first = detectAnomalies(SEEDED, { month: '2026-05' });
    const second = detectAnomalies([...SEEDED].reverse(), { month: '2026-05' });
    expect(second).toEqual(first);
  });

  it('orders the most severe finding first', () => {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const flags = ALL_SEEDED_FLAGS;
    const perMonth = SEEDED_MONTHS.map((month) => detectAnomalies(SEEDED, { month }));

    expect(flags.length).toBeGreaterThan(0);
    perMonth.forEach((month) => {
      const ranks = month.map((f) => order[f.severity]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    });
  });

  it('gives every finding a fingerprint that is stable and unique within a month', () => {
    SEEDED_MONTHS.forEach((month) => {
      const fingerprints = detectAnomalies(SEEDED, { month }).map((f) => f.fingerprint);
      expect(new Set(fingerprints).size).toBe(fingerprints.length);
    });

    expect(detectAnomalies(SEEDED, { month: '2026-06' }).map((f) => f.fingerprint)).toEqual(
      detectAnomalies(SEEDED, { month: '2026-06' }).map((f) => f.fingerprint),
    );
  });
});
