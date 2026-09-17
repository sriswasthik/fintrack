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
  | 'manual-override'
  | 'emi'
  | 'emi-decoy'
  | 'sip'
  | 'festive';

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
    min: 80,
    max: 230,
    merchants: [
      { raw: 'PAYTM*CHAI POINT', normalized: 'CHAI POINT', category: 'DINING', mangled: true },
      {
        raw: 'PAYTM*BLUE TOKAI',
        normalized: 'BLUE TOKAI',
        category: 'DINING',
        mangled: true,
      },
      { raw: 'CAFE COFFEE DAY 0%%%%', normalized: 'CAFE COFFEE DAY', category: 'DINING' },
      { raw: 'THIRD WAVE COFFEE #1174', normalized: 'THIRD WAVE COFFEE', category: 'DINING' },
    ],
  },
  {
    name: 'groceries',
    perWeek: 2.6,
    account: 'checking',
    min: 300,
    max: 1850,
    merchants: [
      { raw: 'RELIANCE FRESH #104', normalized: 'RELIANCE FRESH', category: 'GROCERIES' },
      { raw: 'SPENCERS #421', normalized: 'SPENCERS', category: 'GROCERIES' },
      { raw: 'DMART #1%%%%', normalized: 'DMART', category: 'GROCERIES' },
      { raw: 'BIG BAZAAR 62%%', normalized: 'BIG BAZAAR', category: 'GROCERIES' },
    ],
  },
  {
    name: 'dining',
    perWeek: 3.2,
    account: 'credit',
    min: 150,
    max: 1250,
    weekendBias: 1.6,
    merchants: [
      {
        raw: 'TST* THE ADDA - INDIRANAGAR',
        normalized: 'THE ADDA',
        category: 'DINING',
        mangled: true,
      },
      {
        raw: 'TST* BARBEQUE NATION',
        normalized: 'BARBEQUE NATION',
        category: 'DINING',
        mangled: true,
      },
      { raw: 'SWIGGY*THAI BASIL', normalized: 'SWIGGY', category: 'DINING', mangled: true },
      { raw: 'HALDIRAMS 24%%', normalized: 'HALDIRAMS', category: 'DINING' },
      { raw: 'SAGAR RATNA #0%%', normalized: 'SAGAR RATNA', category: 'DINING' },
    ],
  },
  {
    name: 'transport',
    perWeek: 3.0,
    account: 'checking',
    min: 40,
    max: 600,
    merchants: [
      { raw: 'UBER   *TRIP', normalized: 'UBER', category: 'TRANSPORTATION', mangled: true },
      { raw: 'OLA    *RIDE FRI', normalized: 'OLA', category: 'TRANSPORTATION', mangled: true },
      { raw: 'INDIAN OIL 5748%%%%', normalized: 'INDIAN OIL', category: 'TRANSPORTATION' },
      {
        raw: 'BHARAT PETROLEUM 0%%%%%%',
        normalized: 'BHARAT PETROLEUM',
        category: 'TRANSPORTATION',
      },
      { raw: 'DMRC*METRO RECHARGE', normalized: 'DMRC', category: 'TRANSPORTATION', mangled: true },
    ],
  },
  {
    name: 'shopping',
    perWeek: 2.2,
    account: 'credit',
    min: 250,
    max: 4250,
    merchants: [
      {
        raw: 'AMZN Mktp IN*%%%%%%%',
        normalized: 'AMAZON MARKETPLACE',
        category: 'SHOPPING',
        mangled: true,
      },
      { raw: 'FLIPKART 000%%%%', normalized: 'FLIPKART', category: 'SHOPPING' },
      { raw: 'SP * BATA', normalized: 'BATA', category: 'SHOPPING', mangled: true },
      { raw: 'IKEA HYDERABAD', normalized: 'IKEA', category: 'SHOPPING' },
      { raw: 'RAZ*MEESHO', normalized: 'MEESHO', category: 'SHOPPING', mangled: true },
    ],
  },
  {
    name: 'entertainment',
    perWeek: 1.1,
    account: 'credit',
    min: 150,
    max: 1450,
    weekendBias: 1.8,
    merchants: [
      { raw: 'PVR CINEMAS #0%%%', normalized: 'PVR CINEMAS', category: 'ENTERTAINMENT' },
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
        raw: 'BOOKMYSHOW*EVENT',
        normalized: 'BOOKMYSHOW',
        category: 'ENTERTAINMENT',
        mangled: true,
      },
    ],
  },
  {
    name: 'personal-care',
    perWeek: 0.65,
    account: 'credit',
    min: 200,
    max: 1550,
    merchants: [
      { raw: 'LAKME SALON #34%%', normalized: 'LAKME SALON', category: 'PERSONAL_CARE' },
      { raw: 'NYKAA #0%%%', normalized: 'NYKAA', category: 'PERSONAL_CARE' },
      { raw: 'APOLLO PHARMACY #0%%%%', normalized: 'APOLLO PHARMACY', category: 'PERSONAL_CARE' },
    ],
  },
  {
    name: 'health',
    perWeek: 0.55,
    account: 'credit',
    min: 180,
    max: 2900,
    merchants: [
      { raw: 'MEDPLUS #1%%%%', normalized: 'MEDPLUS', category: 'HEALTH_FITNESS' },
      { raw: 'PRACTO CONSULT', normalized: 'PRACTO', category: 'HEALTH_FITNESS' },
      { raw: 'DR LAL PATHLABS', normalized: 'DR LAL PATHLABS', category: 'HEALTH_FITNESS' },
    ],
  },
  {
    name: 'business',
    perWeek: 0.45,
    account: 'checking',
    min: 250,
    max: 2300,
    merchants: [
      { raw: 'GITHUB.COM*ACCOUNT', normalized: 'GITHUB', category: 'BUSINESS', mangled: true },
      { raw: 'INDIA POST 12%%%%%%', normalized: 'INDIA POST', category: 'BUSINESS' },
      { raw: 'OFFICEYES 004%%', normalized: 'OFFICEYES', category: 'BUSINESS' },
    ],
  },
  {
    name: 'education',
    perWeek: 0.2,
    account: 'credit',
    min: 280,
    max: 3600,
    merchants: [
      { raw: 'UNACADEMY.COM', normalized: 'UNACADEMY', category: 'EDUCATION' },
      { raw: 'BYJUS ONLINE COURSES', normalized: 'BYJUS', category: 'EDUCATION' },
    ],
  },
  {
    name: 'travel',
    perWeek: 0.55,
    account: 'credit',
    min: 600,
    max: 5500,
    merchants: [
      { raw: 'AIRBNB * HM4X%%%%', normalized: 'AIRBNB', category: 'TRAVEL', mangled: true },
      { raw: 'TAJ HOTELS #0%%%', normalized: 'TAJ HOTELS', category: 'TRAVEL' },
      {
        raw: 'MAKEMYTRIP*ITIN 7%%%%%%',
        normalized: 'MAKEMYTRIP',
        category: 'TRAVEL',
        mangled: true,
      },
      { raw: 'IRCTC ETICKET', normalized: 'IRCTC', category: 'TRAVEL' },
    ],
  },
  {
    name: 'gifts',
    perWeek: 0.25,
    account: 'credit',
    min: 280,
    max: 2900,
    merchants: [
      { raw: 'FERNS N PETALS.COM', normalized: 'FERNS N PETALS', category: 'GIFTS_DONATIONS' },
      {
        raw: 'DONATION*GOONJ',
        normalized: 'GOONJ',
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

/**
 * The Phase 19 monthly commitments: an instalment plan and two SIPs.
 *
 * Kept apart from `RECURRING` because they are generated at the very end of the
 * dataset — see the comment there — but they are monthly, fixed-amount and
 * fixed-day, so anything that reasons about recurring charges sees them.
 */
export const FIXED_COMMITMENTS = [
  'BAJAJ FINANCE EMI',
  'ZERODHA COIN SIP',
  'AXIS MUTUAL FUND SIP',
] as const;

export const RECURRING: Recurring[] = [
  // Housing, utilities, insurance — paid from checking.
  {
    day: 1,
    raw: 'PRESTIGE PROPERTY MGMT',
    normalized: 'PRESTIGE PROPERTY MGMT',
    category: 'HOUSING',
    account: 'checking',
    amount: 32000,
  },
  {
    day: 3,
    raw: 'HDFC ERGO INSURANCE',
    normalized: 'HDFC ERGO INSURANCE',
    category: 'INSURANCE',
    account: 'checking',
    amount: 1450,
  },
  {
    day: 5,
    raw: 'JIO FIBER BROADBAND',
    normalized: 'JIO FIBER',
    category: 'UTILITIES',
    account: 'checking',
    amount: 899,
  },
  {
    day: 8,
    raw: 'BESCOM ELECTRICITY',
    normalized: 'BESCOM',
    category: 'UTILITIES',
    account: 'checking',
    amount: [850, 2800],
  },
  {
    day: 12,
    raw: 'AIRTEL PREPAID',
    normalized: 'AIRTEL',
    category: 'UTILITIES',
    account: 'checking',
    amount: 399,
  },
  {
    day: 2,
    raw: 'CULT FIT',
    normalized: 'CULT FIT',
    category: 'HEALTH_FITNESS',
    account: 'checking',
    amount: 1500,
  },

  // Subscriptions — all on the credit card (§8 case 4).
  {
    day: 17,
    raw: 'NETFLIX.COM',
    normalized: 'NETFLIX',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 499,
    priceChange: { fromMonthIndex: 3, amount: 649 },
    edgeCases: ['subscription', 'subscription-price-change'],
  },
  {
    day: 9,
    raw: 'Spotify India',
    normalized: 'SPOTIFY',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 119,
    edgeCases: ['subscription'],
  },
  {
    day: 21,
    raw: 'AMAZON PRIME*MEMBERSHIP',
    normalized: 'AMAZON PRIME',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 299,
    edgeCases: ['subscription', 'mangled-merchant'],
  },
  {
    day: 6,
    raw: 'APPLE.COM/BILL ICLOUD',
    normalized: 'APPLE ICLOUD',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 75,
    edgeCases: ['subscription'],
  },
  {
    day: 24,
    raw: 'ZEE5*PREMIUM PLAN',
    normalized: 'ZEE5',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 99,
    edgeCases: ['subscription', 'mangled-merchant'],
  },
  {
    day: 27,
    raw: 'ADOBE CREATIVE CLOUD',
    normalized: 'ADOBE',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 699,
    edgeCases: ['subscription'],
  },
  // Starts part-way through the window, so Phase 6 has a new recurring charge to find.
  {
    day: 14,
    raw: 'HOTSTAR SUPER',
    normalized: 'HOTSTAR',
    category: 'SUBSCRIPTIONS',
    account: 'credit',
    amount: 299,
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
      const gross = round2(60000 * (0.97 + rng() * 0.06));
      add({
        date: toIso(date),
        description: 'INFOSYS LTD SALARY CREDIT',
        rawMerchant: 'INFOSYS LTD SALARY CREDIT',
        normalizedMerchant: 'INFOSYS LTD',
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
        description: 'RAZORPAY TRANSFER FREELANCE',
        rawMerchant: 'RAZORPAY TRANSFER',
        normalizedMerchant: 'RAZORPAY',
        amount: -money(8000, 45000, rng),
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
          description: 'INFOSYS LTD BONUS',
          rawMerchant: 'INFOSYS LTD BONUS',
          normalizedMerchant: 'INFOSYS LTD',
          amount: -75000,
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
    const amount = money(12000, 42000, rng);
    const pairId = `transfer-${i}`;
    add({
      date: toIso(date),
      description: 'ONLINE PAYMENT TO HDFC CARD ...4021',
      rawMerchant: 'HDFC CARD PAYMENT',
      normalizedMerchant: 'HDFC CARD PAYMENT',
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
      normalizedMerchant: 'HDFC CARD PAYMENT',
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
      raw: 'MYNTRA #482',
      normalized: 'MYNTRA',
      category: 'SHOPPING',
      amount: 2899,
      day: 6,
      monthIndex: 0,
      lag: 9,
    },
    {
      raw: 'NIKE.COM',
      normalized: 'NIKE',
      category: 'SHOPPING',
      amount: 4599,
      day: 11,
      monthIndex: 1,
      lag: 12,
    },
    {
      raw: 'CROMA #1120',
      normalized: 'CROMA',
      category: 'SHOPPING',
      amount: 8999,
      day: 19,
      monthIndex: 2,
      lag: 7,
    },
    {
      raw: 'DECATHLON.COM ONLINE',
      normalized: 'DECATHLON',
      category: 'SHOPPING',
      amount: 5499,
      day: 4,
      monthIndex: 3,
      lag: 13,
    },
    {
      raw: 'AMZN Mktp IN*RT4G21',
      normalized: 'AMAZON MARKETPLACE',
      category: 'SHOPPING',
      amount: 1899,
      day: 13,
      monthIndex: 4,
      lag: 6,
    },
    {
      raw: 'PEPPERFRY.COM ORDER',
      normalized: 'PEPPERFRY',
      category: 'SHOPPING',
      amount: 9499,
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
      raw: 'FLIPKART 0002341',
      normalized: 'FLIPKART',
      day: 9,
      monthIndex: 0,
      splits: [
        { category: 'GROCERIES', amount: 1490, note: 'Weekly food shop' },
        { category: 'PERSONAL_CARE', amount: 635, note: 'Toiletries' },
        { category: 'SHOPPING', amount: 770, note: 'Kitchen storage' },
      ],
    },
    {
      raw: 'RELIANCE SMART #2201',
      normalized: 'RELIANCE SMART',
      day: 17,
      monthIndex: 1,
      splits: [
        { category: 'GROCERIES', amount: 2045, note: 'Groceries' },
        { category: 'SHOPPING', amount: 885, note: 'Headphones' },
      ],
    },
    {
      raw: 'METRO CASH CARRY #1188',
      normalized: 'METRO CASH CARRY',
      day: 25,
      monthIndex: 2,
      splits: [
        { category: 'GROCERIES', amount: 3310, note: 'Bulk groceries' },
        { category: 'HEALTH_FITNESS', amount: 1055, note: 'Pharmacy counter' },
        { category: 'SHOPPING', amount: 905, note: 'Patio chairs' },
      ],
    },
    {
      raw: 'AMZN Mktp IN*8H2K1LM',
      normalized: 'AMAZON MARKETPLACE',
      day: 12,
      monthIndex: 3,
      splits: [
        { category: 'SHOPPING', amount: 1605, note: 'Desk lamp' },
        { category: 'BUSINESS', amount: 800, note: 'Printer toner' },
      ],
    },
    {
      raw: 'SPENCERS HYPER #331',
      normalized: 'SPENCERS HYPER',
      day: 20,
      monthIndex: 4,
      splits: [
        { category: 'GROCERIES', amount: 1865, note: 'Groceries' },
        { category: 'TRANSPORTATION', amount: 885, note: 'Fuel at members pump' },
      ],
    },
    {
      raw: 'IKEA HYDERABAD #442',
      normalized: 'IKEA',
      day: 3,
      monthIndex: 5,
      splits: [
        { category: 'SHOPPING', amount: 4130, note: 'Shelving' },
        { category: 'DINING', amount: 285, note: 'Cafeteria' },
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
      raw: 'DMART #14027',
      normalized: 'DMART',
      category: 'GROCERIES',
      amount: 1284,
      day: 7,
      monthIndex: 0,
    },
    {
      raw: 'INDIAN OIL 574812',
      normalized: 'INDIAN OIL',
      category: 'TRANSPORTATION',
      amount: 1250,
      day: 14,
      monthIndex: 1,
    },
    {
      raw: 'TST* BARBEQUE NATION',
      normalized: 'BARBEQUE NATION',
      category: 'DINING',
      amount: 1899,
      day: 23,
      monthIndex: 2,
    },
    {
      raw: 'AMZN Mktp IN*QQ91ZP',
      normalized: 'AMAZON MARKETPLACE',
      category: 'SHOPPING',
      amount: 649,
      day: 10,
      monthIndex: 3,
    },
    {
      raw: 'RELIANCE FRESH #104',
      normalized: 'RELIANCE FRESH',
      category: 'GROCERIES',
      amount: 2374,
      day: 16,
      monthIndex: 4,
    },
    {
      raw: 'UBER   *TRIP',
      normalized: 'UBER',
      category: 'TRANSPORTATION',
      amount: 289,
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
    { day: 5, monthIndex: 0, amount: 150 },
    { day: 18, monthIndex: 1, amount: 130 },
    { day: 11, monthIndex: 3, amount: 160 },
    { day: 26, monthIndex: 4, amount: 130 },
  ];
  LEGIT_REPEATS.forEach((r, i) => {
    const date = dayOfMonth(months[r.monthIndex], r.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    const pairId = `legit-repeat-${i}`;
    for (let k = 0; k < 2; k++) {
      add({
        date: toIso(date),
        description: 'PAYTM*CHAI POINT',
        rawMerchant: 'PAYTM*CHAI POINT',
        normalizedMerchant: 'CHAI POINT',
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
      amount: 34500,
      day: 15,
      monthIndex: 0,
    },
    {
      raw: 'SNCF INTERNET PARIS FR',
      normalized: 'SNCF',
      category: 'TRAVEL',
      amount: 7400,
      day: 21,
      monthIndex: 1,
    },
    {
      raw: 'MUJI SHIBUYA TOKYO JP',
      normalized: 'MUJI',
      category: 'SHOPPING',
      amount: 5400,
      day: 8,
      monthIndex: 2,
    },
    {
      raw: 'EL CORTE INGLES MADRID ES',
      normalized: 'EL CORTE INGLES',
      category: 'SHOPPING',
      amount: 11100,
      day: 27,
      monthIndex: 3,
    },
    {
      raw: 'TESCO STORES 3411 LONDON UK',
      normalized: 'TESCO',
      category: 'GROCERIES',
      amount: 3480,
      day: 5,
      monthIndex: 4,
    },
    {
      raw: 'TRENITALIA ROMA IT',
      normalized: 'TRENITALIA',
      category: 'TRAVEL',
      amount: 8100,
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
      out: 'GPAY PAYMENT 1039485',
      back: 'GPAY REFUND 1039912',
      normalized: 'GPAY',
      amount: 1500,
      day: 10,
      monthIndex: 0,
      lag: 3,
    },
    {
      out: 'PHONEPE*ARJUN M',
      back: 'PHONEPE*REFUND',
      normalized: 'PHONEPE',
      amount: 800,
      day: 24,
      monthIndex: 1,
      lag: 2,
    },
    {
      out: 'PAYTM WALLET TO SAM R',
      back: 'PAYTM WALLET FROM SAM R',
      normalized: 'PAYTM WALLET',
      amount: 3500,
      day: 6,
      monthIndex: 2,
      lag: 5,
    },
    {
      out: 'GPAY PAYMENT 1104773',
      back: 'GPAY REFUND 1105220',
      normalized: 'GPAY',
      amount: 2200,
      day: 18,
      monthIndex: 3,
      lag: 4,
    },
    {
      out: 'PAYTM WALLET TO PRIYA N',
      back: 'PAYTM WALLET FROM PRIYA N',
      normalized: 'PAYTM WALLET',
      amount: 6000,
      day: 2,
      monthIndex: 4,
      lag: 6,
    },
    {
      out: 'PHONEPE*ALEX T',
      back: 'PHONEPE*REFUND',
      normalized: 'PHONEPE',
      amount: 1800,
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
      raw: 'CROMA RETAIL #R412',
      normalized: 'CROMA RETAIL',
      category: 'SHOPPING',
      amount: 79900,
      day: 16,
      monthIndex: 2,
    },
    {
      raw: 'INDIGO AIRLINES 0062',
      normalized: 'INDIGO AIRLINES',
      category: 'TRAVEL',
      amount: 24500,
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
      raw: 'PAYTM*SABZI MANDI STALL 12',
      normalized: 'SABZI MANDI STALL 12',
      corrected: 'GROCERIES',
      looksLike: 'DINING',
      amount: 850,
      day: 8,
      monthIndex: 1,
    },
    {
      raw: 'RAZ*WWWSTORE',
      normalized: 'WWWSTORE',
      corrected: 'BUSINESS',
      looksLike: 'SHOPPING',
      amount: 2899,
      day: 22,
      monthIndex: 2,
    },
    {
      raw: 'TST* CATERING CO',
      normalized: 'CATERING CO',
      corrected: 'BUSINESS',
      looksLike: 'DINING',
      amount: 6400,
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

  // ---- Phase 19: fixed monthly commitments ------------------------------
  // Deliberately the last section in the generator. Every draft above draws
  // from the same `rng` stream, so anything inserted earlier would re-roll the
  // whole dataset; appending here leaves all 704 existing rows byte-identical.

  /** A consumer-durable EMI: the same rupee, the same day, every month. */
  months.forEach((monthStart) => {
    const date = dayOfMonth(monthStart, 5, START_DATE, REFERENCE_DATE);
    if (!date) return;
    add({
      date: toIso(date),
      description: 'BAJAJ FINANCE EMI 4471902',
      rawMerchant: 'BAJAJ FINANCE EMI',
      normalizedMerchant: 'BAJAJ FINANCE EMI',
      amount: 18450,
      account: 'checking',
      expectedCategory: 'EMI_LOAN',
      edgeCases: ['emi'],
    });
  });

  /**
   * The false positive Phase 19 has to reject: two unrelated repayments to a
   * lender, months apart, for roughly the same money. It reads like an EMI in
   * every way except the two that matter — it does not repeat monthly and it
   * does not repeat enough.
   */
  [
    { monthIndex: 0, day: 19, amount: 18500 },
    { monthIndex: 3, day: 23, amount: 18300 },
  ].forEach((one) => {
    const monthStart = months[one.monthIndex];
    if (!monthStart) return;
    const date = dayOfMonth(monthStart, one.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    add({
      date: toIso(date),
      description: 'MUTHOOT FINANCE',
      rawMerchant: 'MUTHOOT FINANCE',
      normalizedMerchant: 'MUTHOOT FINANCE',
      amount: one.amount,
      account: 'checking',
      expectedCategory: 'EMI_LOAN',
      edgeCases: ['emi-decoy'],
    });
  });

  /** Two SIPs, so the monthly outgo is a sum rather than a single figure. */
  [
    {
      day: 7,
      description: 'ZERODHA COIN SIP',
      raw: 'ZERODHA COIN SIP',
      normalized: 'ZERODHA COIN SIP',
      amount: 5000,
    },
    {
      day: 12,
      description: 'AXIS MUTUAL FUND SIP',
      raw: 'AXIS MUTUAL FUND SIP',
      normalized: 'AXIS MUTUAL FUND SIP',
      amount: 2500,
    },
  ].forEach((sip) => {
    months.forEach((monthStart) => {
      const date = dayOfMonth(monthStart, sip.day, START_DATE, REFERENCE_DATE);
      if (!date) return;
      add({
        date: toIso(date),
        description: sip.description,
        rawMerchant: sip.raw,
        normalizedMerchant: sip.normalized,
        amount: sip.amount,
        account: 'checking',
        expectedCategory: 'INVESTMENTS',
        edgeCases: ['sip'],
      });
    });
  });

  /**
   * A festive-season bump, in the first week of September.
   *
   * September is the only month in this window that overlaps a festive one —
   * Onam and Ganesh Chaturthi fall here, and the big online sales that lead
   * into Dussehra and Diwali open at the end of it. The window stops on the
   * 7th, so the bump is concentrated in those days, which is also what a
   * sale-launch purchase actually looks like: the television is bought on the
   * first morning of the sale, not spread evenly over the month.
   *
   * Deliberately only two of the three categories the detector watches. Dining
   * is left alone, because a plausible festive week does not add nineteen
   * thousand rupees of restaurant meals, and a fixture that fires every rule at
   * once proves less than one that fires the rules it should.
   */
  [
    {
      day: 1,
      raw: 'RELIANCE DIGITAL',
      normalized: 'RELIANCE DIGITAL',
      amount: 28990,
      category: 'SHOPPING' as Category,
    },
    {
      day: 2,
      raw: 'MYNTRA #482',
      normalized: 'MYNTRA',
      amount: 8450,
      category: 'SHOPPING' as Category,
    },
    {
      day: 2,
      raw: 'FERNS N PETALS.COM',
      normalized: 'FERNS N PETALS',
      amount: 4800,
      category: 'GIFTS_DONATIONS' as Category,
    },
    {
      day: 4,
      raw: 'FERNS N PETALS.COM',
      normalized: 'FERNS N PETALS',
      amount: 3900,
      category: 'GIFTS_DONATIONS' as Category,
    },
    {
      day: 5,
      raw: 'DONATION*GOONJ',
      normalized: 'GOONJ',
      amount: 3900,
      category: 'GIFTS_DONATIONS' as Category,
    },
  ].forEach((f) => {
    const monthStart = months[months.length - 1];
    if (!monthStart) return;
    const date = dayOfMonth(monthStart, f.day, START_DATE, REFERENCE_DATE);
    if (!date) return;
    add({
      date: toIso(date),
      description: f.raw,
      rawMerchant: f.raw,
      normalizedMerchant: f.normalized,
      amount: f.amount,
      account: 'credit',
      expectedCategory: f.category,
      edgeCases: ['festive'],
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

/**
 * Merchants the generator bills on a fixed day each month.
 *
 * Derived rather than listed by hand: the accuracy report scores the
 * recurring-charge classifier against this, and a hand-kept copy silently went
 * stale the moment the merchant names changed.
 */
/**
 * Every merchant the generator bills on a fixed day of the month.
 *
 * `RECURRING` covers the bills and subscriptions. The Phase 19 commitments are
 * generated separately — they are not bills — but they bill on exactly the same
 * shape, so Phase 6's recurring-charge detector finds them too and this list
 * has to say so.
 */
export const MONTHLY_BILL_MERCHANTS: string[] = [
  ...new Set([...RECURRING.map((r) => r.normalized), ...FIXED_COMMITMENTS]),
].sort();
