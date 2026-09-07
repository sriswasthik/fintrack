/**
 * Deterministic synthetic-dataset generator for FinTrack.
 *
 * Everything here is a pure function of `SEED` and the fixed date window below —
 * no clock, no randomness that isn't seeded — so the exported CSV, the row
 * numbers quoted in test-data/README.md, and the seeded database all line up and
 * stay stable across runs. Change SEED or the window and every row index moves.
 *
 * The dataset deliberately covers every edge case in PROJECT_CONTEXT.md §8.
 */
import type { Category } from '../src/generated/prisma/enums';

// --------------------------------------------------------------------------
// Fixed parameters
// --------------------------------------------------------------------------

/** Any change to this invalidates the row indices quoted in test-data/README.md. */
export const SEED = 20260301;

/** Inclusive start of the window. */
export const START_DATE = '2026-03-01';
/** Inclusive end of the window ("today", from the dataset's point of view). */
export const REFERENCE_DATE = '2026-09-07';

/** Transactions on or after this date have not cleared yet (§8 case 6). */
export const PENDING_FROM = '2026-09-04';

export const DEMO_USER = {
  email: 'demo@fintrack.local',
  name: 'Demo User',
  /** bcrypt hash of "demo-password-not-a-secret". Demo data only. */
  passwordHash: '$2b$10$Wq3TzqTVy6QxAqCZTYcOQeQ2wJ8YQoV1uJk9nGZ0mQKvXcLsZ0Ry2',
};

export type AccountKey = 'checking' | 'credit';

export const ACCOUNTS: Record<AccountKey, { name: string; type: 'CHECKING' | 'CREDIT_CARD' }> = {
  checking: { name: 'Everyday Checking', type: 'CHECKING' },
  credit: { name: 'Sapphire Credit Card', type: 'CREDIT_CARD' },
};

/** Tags used by test-data/README.md to point tests at the right rows. */
export type EdgeCase =
  | 'transfer-out'
  | 'transfer-in'
  | 'refund-original'
  | 'refund'
  | 'split-candidate'
  | 'subscription'
  | 'subscription-price-change'
  | 'new-subscription'
  | 'duplicate-original'
  | 'duplicate-glitch'
  | 'legit-repeat'
  | 'pending'
  | 'fx-purchase'
  | 'fx-fee'
  | 'mangled-merchant'
  | 'p2p-out'
  | 'p2p-in'
  | 'large-one-off'
  | 'variable-income'
  | 'manual-override';

export interface GeneratedTransaction {
  /** 1-based row number in test-data/synthetic_transactions.csv. Assigned after sorting. */
  row: number;
  /** YYYY-MM-DD. */
  date: string;
  /** YYYY-MM-DD, or null while the transaction is still pending. */
  postedDate: string | null;
  /** The raw line as it appears in a bank export. */
  description: string;
  /** The merchant portion of the description, still messy. */
  rawMerchant: string;
  /** What Phase 2's normalizer is expected to reduce `rawMerchant` to. */
  normalizedMerchant: string;
  /** Debit-positive: purchases are positive, refunds and income are negative. */
  amount: number;
  account: AccountKey;
  /**
   * Ground truth for accuracy measurement in Phase 8. This is NOT written to the
   * database — seeded rows land as UNCATEGORIZED so Phases 3 and 4 have work to do.
   */
  expectedCategory: Category;
  edgeCases: EdgeCase[];
  /** Links the two halves of a pair (transfer, refund, FX fee, P2P round trip, duplicate). */
  pairId?: string;
  /** Set only on the handful of rows demonstrating §8 case 12. */
  manualCategory?: Category;
  /** Intended breakdown for a split-worthy purchase (§8 case 3). Phase 3 creates the rows. */
  intendedSplits?: { category: Category; amount: number; note: string }[];
}

// --------------------------------------------------------------------------
// Deterministic helpers
// --------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

function eachDay(startIso: string, endIso: string): Date[] {
  const out: Date[] = [];
  const end = parseIso(endIso);
  for (let d = parseIso(startIso); d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Months in the window as YYYY-MM, first day of each. */
function monthStarts(startIso: string, endIso: string): Date[] {
  const out: Date[] = [];
  const end = parseIso(endIso);
  const d = parseIso(startIso);
  let cur = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  while (cur <= end) {
    out.push(cur);
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

/** Clamp a day-of-month onto a real date inside the window, or null if outside. */
function dayOfMonth(monthStart: Date, day: number, startIso: string, endIso: string): Date | null {
  const daysInMonth = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const d = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, daysInMonth)),
  );
  if (d < parseIso(startIso) || d > parseIso(endIso)) return null;
  return d;
}

// --------------------------------------------------------------------------
// Merchant catalogue
// --------------------------------------------------------------------------

interface Merchant {
  /** Raw descriptor as a bank would print it. Each `%` becomes a stable pseudo-digit. */
  raw: string;
  /** What Phase 2's normalizer should reduce `raw` to. */
  normalized: string;
  category: Category;
  /** Marks processor-mangled strings (§8 case 8). */
  mangled?: boolean;
}

interface SpendStream {
  name: string;
  /** Average occurrences per week. */
  perWeek: number;
  account: AccountKey;
  min: number;
  max: number;
  merchants: Merchant[];
  /** Multiplier applied on Sat/Sun. */
  weekendBias?: number;
}

const STREAMS: SpendStream[] = [
  {
    name: 'coffee',
    perWeek: 3.6,
    account: 'credit',
    min: 4.25,
    max: 7.4,
    merchants: [
      { raw: 'SQ *JOES COFFEE', normalized: 'JOES COFFEE', category: 'DINING', mangled: true },
      {
        raw: 'SQ *BLUEBIRD BAKERY',
        normalized: 'BLUEBIRD BAKERY',
        category: 'DINING',
        mangled: true,
      },
      { raw: 'STARBUCKS STORE 0%%%%', normalized: 'STARBUCKS', category: 'DINING' },
      { raw: "PEET'S COFFEE #1174", normalized: 'PEETS COFFEE', category: 'DINING' },
    ],
  },
  {
    name: 'groceries',
    perWeek: 2.6,
    account: 'checking',
    min: 34,
    max: 168,
    merchants: [
      { raw: 'WHOLE FOODS MKT #104', normalized: 'WHOLE FOODS', category: 'GROCERIES' },
      { raw: "TRADER JOE'S #421", normalized: 'TRADER JOES', category: 'GROCERIES' },
      { raw: 'SAFEWAY #1%%%%', normalized: 'SAFEWAY', category: 'GROCERIES' },
      { raw: 'ALDI 62%%', normalized: 'ALDI', category: 'GROCERIES' },
    ],
  },
  {
    name: 'dining',
    perWeek: 3.2,
    account: 'credit',
    min: 11.5,
    max: 84,
    weekendBias: 1.6,
    merchants: [
      {
        raw: 'TST* THE HALL - DOWNTOWN',
        normalized: 'THE HALL',
        category: 'DINING',
        mangled: true,
      },
      {
        raw: 'TST* RAMEN TATSU-YA',
        normalized: 'RAMEN TATSU-YA',
        category: 'DINING',
        mangled: true,
      },
      { raw: 'DOORDASH*THAI BASIL', normalized: 'DOORDASH', category: 'DINING', mangled: true },
      { raw: 'CHIPOTLE 24%%', normalized: 'CHIPOTLE', category: 'DINING' },
      { raw: 'SWEETGREEN #0%%', normalized: 'SWEETGREEN', category: 'DINING' },
    ],
  },
  {
    name: 'transport',
    perWeek: 3.0,
    account: 'checking',
    min: 6.5,
    max: 68,
    merchants: [
      { raw: 'UBER   *TRIP', normalized: 'UBER', category: 'TRANSPORTATION', mangled: true },
      { raw: 'LYFT   *RIDE FRI', normalized: 'LYFT', category: 'TRANSPORTATION', mangled: true },
      { raw: 'SHELL OIL 5748%%%%', normalized: 'SHELL', category: 'TRANSPORTATION' },
      { raw: 'CHEVRON 0%%%%%%', normalized: 'CHEVRON', category: 'TRANSPORTATION' },
      { raw: 'MTA*NYCT PAYGO', normalized: 'MTA', category: 'TRANSPORTATION', mangled: true },
    ],
  },
  {
    name: 'shopping',
    perWeek: 2.2,
    account: 'credit',
    min: 14,
    max: 235,
    merchants: [
      {
        raw: 'AMZN Mktp US*%%%%%%%',
        normalized: 'AMAZON MARKETPLACE',
        category: 'SHOPPING',
        mangled: true,
      },
      { raw: 'TARGET 000%%%%', normalized: 'TARGET', category: 'SHOPPING' },
      { raw: 'SP * ALLBIRDS', normalized: 'ALLBIRDS', category: 'SHOPPING', mangled: true },
      { raw: 'IKEA BROOKLYN', normalized: 'IKEA', category: 'SHOPPING' },
      { raw: 'PAYPAL *ETSYINC', normalized: 'ETSY', category: 'SHOPPING', mangled: true },
    ],
  },
  {
    name: 'entertainment',
    perWeek: 1.1,
    account: 'credit',
    min: 11,
    max: 98,
    weekendBias: 1.8,
    merchants: [
      { raw: 'AMC THEATRES #0%%%', normalized: 'AMC THEATRES', category: 'ENTERTAINMENT' },
      {
        raw: 'PAYPAL *STEAMGAMES',
        normalized: 'STEAM',
        category: 'ENTERTAINMENT',
        mangled: true,
      },
      {
        raw: 'WWW.PATREON.COM* SUPPORT',
        normalized: 'PATREON',
        category: 'ENTERTAINMENT',
        mangled: true,
      },
      {
        raw: 'TICKETMASTER*EVENT',
        normalized: 'TICKETMASTER',
        category: 'ENTERTAINMENT',
        mangled: true,
      },
    ],
  },
  {
    name: 'personal-care',
    perWeek: 0.65,
    account: 'credit',
    min: 16,
    max: 92,
    merchants: [
      { raw: 'SUPERCUTS #34%%', normalized: 'SUPERCUTS', category: 'PERSONAL_CARE' },
      { raw: 'SEPHORA #0%%%', normalized: 'SEPHORA', category: 'PERSONAL_CARE' },
      { raw: 'CVS/PHARMACY #0%%%%', normalized: 'CVS PHARMACY', category: 'PERSONAL_CARE' },
    ],
  },
  {
    name: 'health',
    perWeek: 0.55,
    account: 'credit',
    min: 12,
    max: 195,
    merchants: [
      { raw: 'WALGREENS #1%%%%', normalized: 'WALGREENS', category: 'HEALTH_FITNESS' },
      { raw: 'ONE MEDICAL GROUP', normalized: 'ONE MEDICAL', category: 'HEALTH_FITNESS' },
      { raw: 'QUEST DIAGNOSTICS', normalized: 'QUEST DIAGNOSTICS', category: 'HEALTH_FITNESS' },
    ],
  },
  {
    name: 'business',
    perWeek: 0.45,
    account: 'checking',
    min: 18,
    max: 149,
    merchants: [
      { raw: 'GITHUB.COM*ACCOUNT', normalized: 'GITHUB', category: 'BUSINESS', mangled: true },
      { raw: 'USPS PO 12%%%%%%', normalized: 'USPS', category: 'BUSINESS' },
      { raw: 'STAPLES 004%%', normalized: 'STAPLES', category: 'BUSINESS' },
    ],
  },
  {
    name: 'education',
    perWeek: 0.2,
    account: 'credit',
    min: 19,
    max: 240,
    merchants: [
      { raw: 'COURSERA.ORG', normalized: 'COURSERA', category: 'EDUCATION' },
      { raw: 'UDEMY ONLINE COURSES', normalized: 'UDEMY', category: 'EDUCATION' },
    ],
  },
  {
    name: 'travel',
    perWeek: 0.55,
    account: 'credit',
    min: 42,
    max: 640,
    merchants: [
      { raw: 'AIRBNB * HM4X%%%%', normalized: 'AIRBNB', category: 'TRAVEL', mangled: true },
      { raw: 'MARRIOTT HOTELS #0%%%', normalized: 'MARRIOTT', category: 'TRAVEL' },
      { raw: 'EXPEDIA*ITIN 7%%%%%%', normalized: 'EXPEDIA', category: 'TRAVEL', mangled: true },
      { raw: 'AMTRAK .COM', normalized: 'AMTRAK', category: 'TRAVEL' },
    ],
  },
  {
    name: 'gifts',
    perWeek: 0.25,
    account: 'credit',
    min: 20,
    max: 180,
    merchants: [
      { raw: '1-800-FLOWERS.COM', normalized: '1-800-FLOWERS', category: 'GIFTS_DONATIONS' },
      {
        raw: 'DONATION*RED CROSS',
        normalized: 'RED CROSS',
        category: 'GIFTS_DONATIONS',
        mangled: true,
      },
    ],
  },
];

// --------------------------------------------------------------------------
// Recurring commitments
// --------------------------------------------------------------------------

interface Recurring {
  day: number;
  raw: string;
  normalized: string;
  description?: string;
  category: Category;
  account: AccountKey;
  /** Fixed price, or a [min, max] band for variable bills. */
  amount: number | [number, number];
  /** First month index (0 = the first month in the window) this appears in. */
  from?: number;
  /** Price change applied from this month index onwards (§8 case 4). */
  priceChange?: { fromMonthIndex: number; amount: number };
  edgeCases?: EdgeCase[];
}

const RECURRING: Recurring[] = [
  // Housing, utilities, insurance — paid from checking.
  {
    day: 1,
    raw: 'OAKWOOD PROPERTY MGMT',
    normalized: 'OAKWOOD PROPERTY MGMT',
    category: 'HOUSING',
    account: 'checking',
    amount: 2150,
  },
  {
    day: 3,
    raw: 'LEMONADE INSURANCE',
    normalized: 'LEMONADE INSURANCE',
    category: 'INSURANCE',
    account: 'checking',
    amount: 18.5,
  },
  {
    day: 5,
    raw: 'SONIC FIBER INTERNET',
    normalized: 'SONIC FIBER',
    category: 'UTILITIES',
    account: 'checking',
    amount: 79.99,
  },
  {
    day: 8,
    raw: 'PG&E WEB ONLINE',
    normalized: 'PGE',
    category: 'UTILITIES',
    account: 'checking',
    amount: [58, 143],
  },
  {
    day: 12,
    raw: 'MINT MOBILE WIRELESS',
    normalized: 'MINT MOBILE',
    category: 'UTILITIES',
    account: 'checking',
    amount: 55,
  },
  {
    day: 2,
    raw: 'PLANET FITNESS CLUB',
    normalized: 'PLANET FITNESS',
    category: 'HEALTH_FITNESS',
    account: 'checking',
    amount: 45,
  },

  // Subscriptions — all on the credit card (§8 case 4).
  {
    day: 17,
    raw: 'NETFLIX.COM',
    normalized: 'NETFLIX',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 15.49,
    priceChange: { fromMonthIndex: 3, amount: 17.99 },
    edgeCases: ['subscription', 'subscription-price-change'],
  },
  {
    day: 9,
    raw: 'Spotify USA',
    normalized: 'SPOTIFY',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 11.99,
    edgeCases: ['subscription'],
  },
  {
    day: 21,
    raw: 'AMAZON PRIME*MEMBERSHIP',
    normalized: 'AMAZON PRIME',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 14.99,
    edgeCases: ['subscription', 'mangled-merchant'],
  },
  {
    day: 6,
    raw: 'APPLE.COM/BILL ICLOUD',
    normalized: 'APPLE ICLOUD',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 2.99,
    edgeCases: ['subscription'],
  },
  {
    day: 24,
    raw: 'NYTIMES*NYTIMES DIGITAL',
    normalized: 'NEW YORK TIMES',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 4,
    edgeCases: ['subscription', 'mangled-merchant'],
  },
  {
    day: 27,
    raw: 'ADOBE CREATIVE CLOUD',
    normalized: 'ADOBE',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 22.99,
    edgeCases: ['subscription'],
  },
  // Starts part-way through the window, so Phase 6 has a new recurring charge to find.
  {
    day: 14,
    raw: 'DISNEY PLUS',
    normalized: 'DISNEY PLUS',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 13.99,
    from: 4,
    edgeCases: ['subscription', 'new-subscription'],
  },
];

// --------------------------------------------------------------------------
// Generator
// --------------------------------------------------------------------------

type Draft = Omit<GeneratedTransaction, 'row'>;

/**
 * Replace each `%` in a raw descriptor with a deterministic digit. A literal `#`
 * is left alone — plenty of real descriptors carry a store number like `#1174`.
 */
function fillIds(raw: string, rng: () => number): string {
  return raw.replace(/%/g, () => String(Math.floor(rng() * 10)));
}

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

function money(min: number, max: number, rng: () => number): number {
  return round2(min + rng() * (max - min));
}

export function generateDataset(): GeneratedTransaction[] {
  const rng = mulberry32(SEED);
  const drafts: Draft[] = [];
  const months = monthStarts(START_DATE, REFERENCE_DATE);
  const pendingFrom = parseIso(PENDING_FROM);

  /** Adds a transaction, deriving postedDate and the pending tag from the date. */
  function add(t: Omit<Draft, 'postedDate' | 'edgeCases'> & { edgeCases?: EdgeCase[] }): Draft {
    const date = parseIso(t.date);
    const isPending = date >= pendingFrom;
    const settleLag = 1 + Math.floor(rng() * 3);
    const posted = addDays(date, settleLag);
    const end = parseIso(REFERENCE_DATE);
    const draft: Draft = {
      ...t,
      postedDate: isPending ? null : toIso(posted > end ? end : posted),
      edgeCases: [...(t.edgeCases ?? []), ...(isPending ? (['pending'] as EdgeCase[]) : [])],
    };
    drafts.push(draft);
    return draft;
  }

  // ---- Recurring bills and subscriptions -------------------------------
  RECURRING.forEach((r) => {
    months.forEach((monthStart, monthIndex) => {
      if (r.from !== undefined && monthIndex < r.from) return;
      const date = dayOfMonth(monthStart, r.day, START_DATE, REFERENCE_DATE);
      if (!date) return;

      let amount: number;
      if (r.priceChange && monthIndex >= r.priceChange.fromMonthIndex) {
        amount = r.priceChange.amount;
      } else if (Array.isArray(r.amount)) {
        amount = money(r.amount[0], r.amount[1], rng);
      } else {
        amount = r.amount;
      }

      const raw = fillIds(r.raw, rng);
      add({
        date: toIso(date),
        description: r.description ?? raw,
        rawMerchant: raw,
        normalizedMerchant: r.normalized,
        amount,
        account: r.account,
        expectedCategory: r.category,
        edgeCases: r.edgeCases,
      });
    });
  });

  // ---- Income (§8 case 11: irregular / variable) ------------------------
  months.forEach((monthStart, monthIndex) => {
    // Semi-monthly salary with small variation (overtime, benefit changes).
    [15, 30].forEach((day) => {
      const date = dayOfMonth(monthStart, day, START_DATE, REFERENCE_DATE);
      if (!date) return;
      const gross = round2(3450 * (0.97 + rng() * 0.06));
      add({
        date: toIso(date),
        description: 'NORTHWIND LABS DIRECT DEP',
        rawMerchant: 'NORTHWIND LABS DIRECT DEP',
        normalizedMerchant: 'NORTHWIND LABS',
        amount: -gross,
        account: 'checking',
        expectedCategory: 'INCOME',
        edgeCases: ['variable-income'],
      });
    });

    // Freelance work: irregular in both timing and size.
    const freelanceCount = rng() < 0.35 ? 0 : rng() < 0.75 ? 1 : 2;
    for (let i = 0; i < freelanceCount; i++) {
      const date = dayOfMonth(monthStart, 4 + Math.floor(rng() * 22), START_DATE, REFERENCE_DATE);
      if (!date) continue;
      add({
        date: toIso(date),
        description: 'STRIPE TRANSFER FREELANCE',
        rawMerchant: 'STRIPE TRANSFER',
        normalizedMerchant: 'STRIPE',
        amount: -money(420, 2250, rng),
        account: 'checking',
        expectedCategory: 'INCOME',
        edgeCases: ['variable-income', 'mangled-merchant'],
      });
    }

    // A one-off bonus, so one month's income is a clear outlier.
    if (monthIndex === 4) {
      const date = dayOfMonth(monthStart, 18, START_DATE, REFERENCE_DATE);
      if (date) {
        add({
          date: toIso(date),
          description: 'NORTHWIND LABS BONUS',
          rawMerchant: 'NORTHWIND LABS BONUS',
          normalizedMerchant: 'NORTHWIND LABS',
          amount: -4500,
          account: 'checking',
          expectedCategory: 'INCOME',
          edgeCases: ['variable-income'],
        });
      }
    }
  });

  // ---- §8 case 1: transfers between the user's own accounts -------------
  months.forEach((monthStart, i) => {
    const date = dayOfMonth(monthStart, 22, START_DATE, REFERENCE_DATE);
    if (!date) return;
    const amount = money(620, 1480, rng);
    const pairId = `transfer-${i}`;
    add({
      date: toIso(date),
      description: 'ONLINE PAYMENT TO CHASE CARD ...4021',
      rawMerchant: 'CHASE CARD PAYMENT',
      normalizedMerchant: 'CHASE CARD PAYMENT',
      amount,
      account: 'checking',
      expectedCategory: 'TRANSFER',
      edgeCases: ['transfer-out'],
      pairId,
    });
    add({
      date: toIso(date),
      description: 'PAYMENT THANK YOU - MOBILE',
      rawMerchant: 'PAYMENT THANK YOU',
      normalizedMerchant: 'CHASE CARD PAYMENT',
      amount: -amount,
      account: 'credit',
      expectedCategory: 'TRANSFER',
      edgeCases: ['transfer-in'],
      pairId,
    });
  });

  // ---- §8 case 2: refunds matched back to a prior purchase --------------
  const REFUNDABLE: {
    raw: string;
    normalized: string;
    category: Category;
    amount: number;
    day: number;
    monthIndex: number;
    lag: number;
  }[] = [
    {
      raw: 'ZARA #482 SOHO',
      normalized: 'ZARA',
      category: 'SHOPPING',
      amount: 128.9,
      day: 6,
      monthIndex: 0,
      lag: 9,
    },
    {
      raw: 'NIKE.COM',
      normalized: 'NIKE',
      category: 'SHOPPING',
      amount: 174.25,
      day: 11,
      monthIndex: 1,
      lag: 12,
    },
    {
      raw: 'BEST BUY #1120',
      normalized: 'BEST BUY',
      category: 'SHOPPING',
      amount: 319.99,
      day: 19,
      monthIndex: 2,
      lag: 7,
    },
    {
      raw: 'REI.COM ONLINE',
      normalized: 'REI',
      category: 'SHOPPING',
      amount: 246.5,
      day: 4,
      monthIndex: 3,
      lag: 13,
    },
    {
      raw: 'AMZN Mktp US*RT4G21',
      normalized: 'AMAZON MARKETPLACE',
      category: 'SHOPPING',
      amount: 89.99,
      day: 13,
      monthIndex: 4,
      lag: 6,
    },
    {
      raw: 'WAYFAIR.COM ORDER',
      normalized: 'WAYFAIR',
      category: 'SHOPPING',
      amount: 412.75,
      day: 8,
      monthIndex: 5,
      lag: 11,
    },
  ];
  REFUNDABLE.forEach((r, i) => {
    const purchaseDate = dayOfMonth(months[r.monthIndex], r.day, START_DATE, REFERENCE_DATE);
    if (!purchaseDate) return;
    const refundDate = addDays(purchaseDate, r.lag);
    if (refundDate > parseIso(REFERENCE_DATE)) return;
    const pairId = `refund-${i}`;
    add({
      date: toIso(purchaseDate),
      description: r.raw,
      rawMerchant: r.raw,
      normalizedMerchant: r.normalized,
      amount: r.amount,
      account: 'credit',
      expectedCategory: r.category,
      edgeCases: ['refund-original'],
      pairId,
    });
    add({
      date: toIso(refundDate),
      description: `${r.raw} REFUND`,
      rawMerchant: r.raw,
      normalizedMerchant: r.normalized,
      amount: -r.amount,
      account: 'credit',
      expectedCategory: 'REFUND',
      edgeCases: ['refund'],
      pairId,
    });
  });

  // ---- §8 case 3: split-worthy purchases --------------------------------
  const SPLITTABLE: {
    raw: string;
    normalized: string;
    day: number;
    monthIndex: number;
    splits: { category: Category; amount: number; note: string }[];
  }[] = [
    {
      raw: 'TARGET 0002341',
      normalized: 'TARGET',
      day: 9,
      monthIndex: 0,
      splits: [
        { category: 'GROCERIES', amount: 96.4, note: 'Weekly food shop' },
        { category: 'PERSONAL_CARE', amount: 41.15, note: 'Toiletries' },
        { category: 'SHOPPING', amount: 49.88, note: 'Kitchen storage' },
      ],
    },
    {
      raw: 'WALMART SUPERCENTER #2201',
      normalized: 'WALMART',
      day: 17,
      monthIndex: 1,
      splits: [
        { category: 'GROCERIES', amount: 132.6, note: 'Groceries' },
        { category: 'SHOPPING', amount: 82.28, note: 'Headphones' },
      ],
    },
    {
      raw: 'COSTCO WHSE #1188',
      normalized: 'COSTCO',
      day: 25,
      monthIndex: 2,
      splits: [
        { category: 'GROCERIES', amount: 214.9, note: 'Bulk groceries' },
        { category: 'HEALTH_FITNESS', amount: 68.5, note: 'Pharmacy counter' },
        { category: 'SHOPPING', amount: 58.77, note: 'Patio chairs' },
      ],
    },
    {
      raw: 'AMZN Mktp US*8H2K1LM',
      normalized: 'AMAZON MARKETPLACE',
      day: 12,
      monthIndex: 3,
      splits: [
        { category: 'SHOPPING', amount: 104.32, note: 'Desk lamp' },
        { category: 'BUSINESS', amount: 52.0, note: 'Printer toner' },
      ],
    },
    {
      raw: "BJ'S WHOLESALE #331",
      normalized: 'BJS WHOLESALE',
      day: 20,
      monthIndex: 4,
      splits: [
        { category: 'GROCERIES', amount: 121.05, note: 'Groceries' },
        { category: 'TRANSPORTATION', amount: 57.5, note: 'Fuel at members pump' },
      ],
    },
    {
      raw: 'IKEA BROOKLYN #442',
      normalized: 'IKEA',
      day: 3,
      monthIndex: 5,
      splits: [
        { category: 'SHOPPING', amount: 268.0, note: 'Shelving' },
        { category: 'DINING', amount: 18.4, note: 'Cafeteria' },
      ],
    },
  ];
  SPLITTABLE.forEach((s) => {
    const date = dayOfMonth(months[s.monthIndex], s.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    const total = round2(s.splits.reduce((sum, p) => sum + p.amount, 0));
    add({
      date: toIso(date),
      description: s.raw,
      rawMerchant: s.raw,
      normalizedMerchant: s.normalized,
      amount: total,
      account: 'credit',
      expectedCategory: 'SHOPPING',
      edgeCases: ['split-candidate'],
      intendedSplits: s.splits,
    });
  });

  // ---- §8 case 5a: sync-glitch duplicates -------------------------------
  const DUPLICATES: {
    raw: string;
    normalized: string;
    category: Category;
    amount: number;
    day: number;
    monthIndex: number;
  }[] = [
    {
      raw: 'SAFEWAY #14027',
      normalized: 'SAFEWAY',
      category: 'GROCERIES',
      amount: 64.18,
      day: 7,
      monthIndex: 0,
    },
    {
      raw: 'SHELL OIL 574812',
      normalized: 'SHELL',
      category: 'TRANSPORTATION',
      amount: 52.4,
      day: 14,
      monthIndex: 1,
    },
    {
      raw: 'TST* RAMEN TATSU-YA',
      normalized: 'RAMEN TATSU-YA',
      category: 'DINING',
      amount: 38.75,
      day: 23,
      monthIndex: 2,
    },
    {
      raw: 'AMZN Mktp US*QQ91ZP',
      normalized: 'AMAZON MARKETPLACE',
      category: 'SHOPPING',
      amount: 27.99,
      day: 10,
      monthIndex: 3,
    },
    {
      raw: 'WHOLE FOODS MKT #104',
      normalized: 'WHOLE FOODS',
      category: 'GROCERIES',
      amount: 118.62,
      day: 16,
      monthIndex: 4,
    },
    {
      raw: 'UBER   *TRIP',
      normalized: 'UBER',
      category: 'TRANSPORTATION',
      amount: 31.2,
      day: 2,
      monthIndex: 5,
    },
  ];
  DUPLICATES.forEach((d, i) => {
    const date = dayOfMonth(months[d.monthIndex], d.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    const pairId = `duplicate-${i}`;
    const base = {
      date: toIso(date),
      description: d.raw,
      rawMerchant: d.raw,
      normalizedMerchant: d.normalized,
      amount: d.amount,
      account: 'credit' as AccountKey,
      expectedCategory: d.category,
      pairId,
    };
    add({ ...base, edgeCases: ['duplicate-original'] });
    add({ ...base, edgeCases: ['duplicate-glitch'] });
  });

  // ---- §8 case 5b: legitimate same-day, same-amount repeats -------------
  // The false-positive trap: two identical coffees on one day are not a glitch.
  const LEGIT_REPEATS: { day: number; monthIndex: number; amount: number }[] = [
    { day: 5, monthIndex: 0, amount: 5.25 },
    { day: 18, monthIndex: 1, amount: 4.75 },
    { day: 11, monthIndex: 3, amount: 5.5 },
    { day: 26, monthIndex: 4, amount: 4.75 },
  ];
  LEGIT_REPEATS.forEach((r, i) => {
    const date = dayOfMonth(months[r.monthIndex], r.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    const pairId = `legit-repeat-${i}`;
    for (let k = 0; k < 2; k++) {
      add({
        date: toIso(date),
        description: 'SQ *JOES COFFEE',
        rawMerchant: 'SQ *JOES COFFEE',
        normalizedMerchant: 'JOES COFFEE',
        amount: r.amount,
        account: 'credit',
        expectedCategory: 'DINING',
        edgeCases: ['legit-repeat', 'mangled-merchant'],
        pairId,
      });
    }
  });

  // ---- §8 case 7: foreign transaction fees split from the purchase ------
  const FOREIGN: {
    raw: string;
    normalized: string;
    category: Category;
    amount: number;
    day: number;
    monthIndex: number;
  }[] = [
    {
      raw: 'BOOKING.COM AMSTERDAM NL',
      normalized: 'BOOKING.COM',
      category: 'TRAVEL',
      amount: 412.3,
      day: 15,
      monthIndex: 0,
    },
    {
      raw: 'SNCF INTERNET PARIS FR',
      normalized: 'SNCF',
      category: 'TRAVEL',
      amount: 88.4,
      day: 21,
      monthIndex: 1,
    },
    {
      raw: 'MUJI SHIBUYA TOKYO JP',
      normalized: 'MUJI',
      category: 'SHOPPING',
      amount: 64.2,
      day: 8,
      monthIndex: 2,
    },
    {
      raw: 'EL CORTE INGLES MADRID ES',
      normalized: 'EL CORTE INGLES',
      category: 'SHOPPING',
      amount: 132.75,
      day: 27,
      monthIndex: 3,
    },
    {
      raw: 'TESCO STORES 3411 LONDON UK',
      normalized: 'TESCO',
      category: 'GROCERIES',
      amount: 41.6,
      day: 5,
      monthIndex: 4,
    },
    {
      raw: 'TRENITALIA ROMA IT',
      normalized: 'TRENITALIA',
      category: 'TRAVEL',
      amount: 96.85,
      day: 19,
      monthIndex: 5,
    },
  ];
  FOREIGN.forEach((f, i) => {
    const date = dayOfMonth(months[f.monthIndex], f.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    const pairId = `fx-${i}`;
    add({
      date: toIso(date),
      description: f.raw,
      rawMerchant: f.raw,
      normalizedMerchant: f.normalized,
      amount: f.amount,
      account: 'credit',
      expectedCategory: f.category,
      edgeCases: ['fx-purchase'],
      pairId,
    });
    // Banks post the 3% fee as its own line, same day, same merchant reference.
    add({
      date: toIso(date),
      description: 'FOREIGN TRANSACTION FEE',
      rawMerchant: 'FOREIGN TRANSACTION FEE',
      normalizedMerchant: 'FOREIGN TRANSACTION FEE',
      amount: round2(f.amount * 0.03),
      account: 'credit',
      expectedCategory: 'FEES_INTEREST',
      edgeCases: ['fx-fee'],
      pairId,
    });
  });

  // ---- §8 case 9: person-to-person payments that round-trip -------------
  const P2P: {
    out: string;
    back: string;
    normalized: string;
    amount: number;
    day: number;
    monthIndex: number;
    lag: number;
  }[] = [
    {
      out: 'VENMO PAYMENT 1039485',
      back: 'VENMO CASHOUT 1039912',
      normalized: 'VENMO',
      amount: 45,
      day: 10,
      monthIndex: 0,
      lag: 3,
    },
    {
      out: 'CASH APP*JORDAN M',
      back: 'CASH APP*CASHOUT',
      normalized: 'CASH APP',
      amount: 30,
      day: 24,
      monthIndex: 1,
      lag: 2,
    },
    {
      out: 'ZELLE TO SAM RIVERA',
      back: 'ZELLE FROM SAM RIVERA',
      normalized: 'ZELLE',
      amount: 120,
      day: 6,
      monthIndex: 2,
      lag: 5,
    },
    {
      out: 'VENMO PAYMENT 1104773',
      back: 'VENMO CASHOUT 1105220',
      normalized: 'VENMO',
      amount: 72.5,
      day: 18,
      monthIndex: 3,
      lag: 4,
    },
    {
      out: 'ZELLE TO PRIYA N',
      back: 'ZELLE FROM PRIYA N',
      normalized: 'ZELLE',
      amount: 210,
      day: 2,
      monthIndex: 4,
      lag: 6,
    },
    {
      out: 'CASH APP*ALEX T',
      back: 'CASH APP*CASHOUT',
      normalized: 'CASH APP',
      amount: 64,
      day: 13,
      monthIndex: 5,
      lag: 3,
    },
  ];
  P2P.forEach((p, i) => {
    const outDate = dayOfMonth(months[p.monthIndex], p.day, START_DATE, REFERENCE_DATE);
    if (!outDate) return;
    const backDate = addDays(outDate, p.lag);
    if (backDate > parseIso(REFERENCE_DATE)) return;
    const pairId = `p2p-${i}`;
    add({
      date: toIso(outDate),
      description: p.out,
      rawMerchant: p.out,
      normalizedMerchant: p.normalized,
      amount: p.amount,
      account: 'checking',
      expectedCategory: 'TRANSFER',
      edgeCases: ['p2p-out', 'mangled-merchant'],
      pairId,
    });
    add({
      date: toIso(backDate),
      description: p.back,
      rawMerchant: p.back,
      normalizedMerchant: p.normalized,
      amount: -p.amount,
      account: 'checking',
      expectedCategory: 'TRANSFER',
      edgeCases: ['p2p-in', 'mangled-merchant'],
      pairId,
    });
  });

  // ---- §8 case 10: large one-off purchases ------------------------------
  const LARGE: {
    raw: string;
    normalized: string;
    category: Category;
    amount: number;
    day: number;
    monthIndex: number;
  }[] = [
    {
      raw: 'APPLE STORE #R412',
      normalized: 'APPLE STORE',
      category: 'SHOPPING',
      amount: 3299,
      day: 16,
      monthIndex: 2,
    },
    {
      raw: 'DELTA AIR LINES 0062',
      normalized: 'DELTA AIR LINES',
      category: 'TRAVEL',
      amount: 1842.6,
      day: 7,
      monthIndex: 4,
    },
  ];
  LARGE.forEach((l) => {
    const date = dayOfMonth(months[l.monthIndex], l.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    add({
      date: toIso(date),
      description: l.raw,
      rawMerchant: l.raw,
      normalizedMerchant: l.normalized,
      amount: l.amount,
      account: 'credit',
      expectedCategory: l.category,
      edgeCases: ['large-one-off'],
    });
  });

  // ---- §8 case 12: corrections a user already made by hand ---------------
  // Seeded with source = MANUAL plus a matching learned Rule, so a re-import and
  // a re-run of the rule/LLM engine must leave them alone.
  const MANUAL: {
    raw: string;
    normalized: string;
    corrected: Category;
    looksLike: Category;
    amount: number;
    day: number;
    monthIndex: number;
  }[] = [
    {
      raw: 'SQ *FARMERS MKT STALL 12',
      normalized: 'FARMERS MKT STALL 12',
      corrected: 'GROCERIES',
      looksLike: 'DINING',
      amount: 38.5,
      day: 8,
      monthIndex: 1,
    },
    {
      raw: 'PAYPAL *WWWSTORE',
      normalized: 'WWWSTORE',
      corrected: 'BUSINESS',
      looksLike: 'SHOPPING',
      amount: 129.0,
      day: 22,
      monthIndex: 2,
    },
    {
      raw: 'TST* CATERING CO',
      normalized: 'CATERING CO',
      corrected: 'BUSINESS',
      looksLike: 'DINING',
      amount: 264.4,
      day: 15,
      monthIndex: 4,
    },
  ];
  MANUAL.forEach((m) => {
    const date = dayOfMonth(months[m.monthIndex], m.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    add({
      date: toIso(date),
      description: m.raw,
      rawMerchant: m.raw,
      normalizedMerchant: m.normalized,
      amount: m.amount,
      account: 'credit',
      expectedCategory: m.corrected,
      edgeCases: ['manual-override', 'mangled-merchant'],
      manualCategory: m.corrected,
    });
  });

  // ---- Everyday variable spend -----------------------------------------
  eachDay(START_DATE, REFERENCE_DATE).forEach((day) => {
    const isWeekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    STREAMS.forEach((stream) => {
      const rate =
        (stream.perWeek / 7) * (isWeekend && stream.weekendBias ? stream.weekendBias : 1);
      let count = Math.floor(rate);
      if (rng() < rate - count) count += 1;
      for (let i = 0; i < count; i++) {
        const merchant = pick(stream.merchants, rng);
        const raw = fillIds(merchant.raw, rng);
        add({
          date: toIso(day),
          description: raw,
          rawMerchant: raw,
          normalizedMerchant: merchant.normalized,
          amount: money(stream.min, stream.max, rng),
          account: stream.account,
          expectedCategory: merchant.category,
          edgeCases: merchant.mangled ? ['mangled-merchant'] : [],
        });
      }
    });
  });

  // ---- Sort and assign the row numbers the README refers to -------------
  const ordinal = new Map<Draft, number>();
  drafts.forEach((d, i) => ordinal.set(d, i));
  const sorted = [...drafts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (ordinal.get(a) ?? 0) - (ordinal.get(b) ?? 0);
  });

  return sorted.map((d, i) => ({ ...d, row: i + 1 }));
}

/** Convenience view used by the CSV exporter and the README generator. */
export function transactionsByEdgeCase(
  dataset: GeneratedTransaction[],
): Map<EdgeCase, GeneratedTransaction[]> {
  const out = new Map<EdgeCase, GeneratedTransaction[]>();
  dataset.forEach((t) => {
    t.edgeCases.forEach((c) => {
      const list = out.get(c) ?? [];
      list.push(t);
      out.set(c, list);
    });
  });
  return out;
}
