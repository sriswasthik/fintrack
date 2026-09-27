/**
 * Dashboard aggregation.
 *
 * One round trip. Every figure the dashboard shows comes out of a single SQL
 * statement, because the alternative — a query per card, per category, per
 * merchant — is the N+1 that makes a dashboard feel slow the moment a user has
 * a real amount of history.
 *
 * Three rules from PROJECT_CONTEXT.md §5 shape the SQL, and each of them is a
 * way of getting the totals wrong if you skip it:
 *
 *   1. TRANSFER is excluded from spend *and* from income. Moving $1,200 from
 *      checking to a credit card is not $1,200 of spending, and the incoming leg
 *      is not $1,200 of income.
 *   2. A REFUND nets against the category of the purchase it offsets, rather
 *      than sitting in its own bucket while the purchase stays at full price.
 *      A $412 sofa returned is $0 of furniture, not $412 of furniture and $412
 *      of "refunds".
 *   3. A split transaction is counted by its parts, never by its parent as well.
 *      Phase 3 introduced splits; counting both would double every split charge.
 *
 * And one of its own: money *in* that nobody has categorized yet is neither
 * spending nor income. Netting it against spending — the way a refund nets —
 * turned an unrecognised salary credit into "you spent minus ₹24,000". It is
 * reported on its own as `unreviewedIn` until someone says what it was.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import type { Category } from '../../generated/prisma/enums';
import { percentageChange } from './window';

export type Granularity = 'daily' | 'weekly';

export interface DashboardQuery {
  userId: string;
  /** Inclusive start of the window. */
  from: Date;
  /** Exclusive end of the window. */
  to: Date;
  /** Inclusive start of the comparison window (the preceding period). */
  previousFrom: Date;
  /** Exclusive end of the comparison window. */
  previousTo: Date;
  accountId?: string;
  categories?: Category[];
  granularity: Granularity;
}

export interface CategoryTotal {
  category: Category;
  amount: number;
  transactions: number;
  share: number;
}

export interface SeriesPoint {
  /** ISO date of the bucket start. */
  date: string;
  spend: number;
}

export interface MerchantTotal {
  merchant: string;
  amount: number;
  transactions: number;
}

export interface DashboardTotals {
  spend: number;
  income: number;
  net: number;
  transactions: number;
  /** Money in not yet categorized, as a magnitude. In neither spend nor income. */
  unreviewedIn: number;
}

export interface DashboardResult {
  totals: DashboardTotals;
  previous: DashboardTotals;
  deltas: {
    /** Percentage change vs the previous period, or null when it had nothing. */
    spend: number | null;
    income: number | null;
  };
  byCategory: CategoryTotal[];
  series: SeriesPoint[];
  topMerchants: MerchantTotal[];
  availableMonths: string[];
}

/** Rows Postgres hands back; every numeric arrives as a string or null. */
interface RawTotals {
  spend: string | null;
  income: string | null;
  transactions: string | null;
  unreviewed_in: string | null;
}

interface RawResult {
  totals: RawTotals | null;
  previous: RawTotals | null;
  by_category: { category: Category; amount: string; transactions: string }[] | null;
  series: { bucket_start: string; spend: string }[] | null;
  top_merchants: { merchant: string; amount: string; transactions: string }[] | null;
  available_months: string[] | null;
}

const num = (value: string | null | undefined): number =>
  value === null || value === undefined ? 0 : Math.round(Number(value) * 100) / 100;

export async function aggregateDashboard(
  prisma: PrismaClient,
  query: DashboardQuery,
): Promise<DashboardResult> {
  const { userId, from, to, previousFrom, previousTo, accountId, categories, granularity } = query;

  // `null` means "no filter" for both optional filters; passing them as
  // parameters rather than interpolating keeps this a prepared statement.
  const accountFilter = accountId ?? null;
  const categoryFilter = categories && categories.length > 0 ? categories : null;
  const bucket = granularity === 'weekly' ? 'week' : 'day';

  const [row] = await prisma.$queryRaw<RawResult[]>`
    WITH base AS (
      SELECT
        t.id,
        t.date,
        t."normalizedMerchant" AS merchant,
        t.amount,
        -- A refund is attributed to the category of the purchase it offsets.
        -- The link lives on the purchase (Phase 1 schema), so the join runs
        -- from the refund back to whichever row points at it.
        CASE
          WHEN t.category = 'REFUND' AND original.id IS NOT NULL THEN original.category
          ELSE t.category
        END AS category,
        (t.date >= ${from} AND t.date < ${to}) AS in_current,
        (t.date >= ${previousFrom} AND t.date < ${previousTo}) AS in_previous
      FROM "Transaction" t
      JOIN "Account" a ON a.id = t."accountId"
      LEFT JOIN "Transaction" original
        ON original."linkedRefundId" = t.id AND t.category = 'REFUND'
      WHERE a."userId" = ${userId}
        AND t.date >= ${previousFrom}
        AND t.date < ${to}
        AND (${accountFilter}::text IS NULL OR t."accountId" = ${accountFilter})
    ),
    -- A split transaction contributes its parts; an unsplit one contributes
    -- itself. Never both.
    expanded AS (
      SELECT b.id, b.date, b.merchant, b.category, b.amount, b.in_current, b.in_previous
      FROM base b
      WHERE NOT EXISTS (SELECT 1 FROM "Split" s WHERE s."transactionId" = b.id)
      UNION ALL
      SELECT b.id, b.date, b.merchant, s.category, s.amount, b.in_current, b.in_previous
      FROM base b
      JOIN "Split" s ON s."transactionId" = b.id
    ),
    filtered AS (
      SELECT
        e.*,
        -- Bucketed once here so the time-series GROUP BY can name a plain
        -- column; repeating a parameterized date_trunc() in both SELECT and
        -- GROUP BY does not reliably match.
        to_char(date_trunc(${bucket}, e.date), 'YYYY-MM-DD') AS bucket_start
      FROM expanded e
      WHERE (${categoryFilter}::text[] IS NULL OR e.category::text = ANY(${categoryFilter}::text[]))
    ),
    -- Spend excludes both TRANSFER and INCOME (§5), and money in that nobody
    -- has categorized yet, which is not a refund of anything we know of.
    spend_rows AS (
      SELECT * FROM filtered
      WHERE category NOT IN ('TRANSFER', 'INCOME')
        AND NOT (category = 'UNCATEGORIZED' AND amount < 0)
    )
    SELECT
      (SELECT json_build_object(
          'spend',        COALESCE(SUM(amount) FILTER (WHERE in_current AND category NOT IN ('TRANSFER','INCOME')
                            AND NOT (category = 'UNCATEGORIZED' AND amount < 0)), 0),
          'income',       COALESCE(-SUM(amount) FILTER (WHERE in_current AND category = 'INCOME'), 0),
          'transactions', COUNT(DISTINCT id) FILTER (WHERE in_current),
          'unreviewed_in', COALESCE(-SUM(amount) FILTER (WHERE in_current AND category = 'UNCATEGORIZED' AND amount < 0), 0)
        ) FROM filtered) AS totals,
      (SELECT json_build_object(
          'spend',        COALESCE(SUM(amount) FILTER (WHERE in_previous AND category NOT IN ('TRANSFER','INCOME')
                            AND NOT (category = 'UNCATEGORIZED' AND amount < 0)), 0),
          'income',       COALESCE(-SUM(amount) FILTER (WHERE in_previous AND category = 'INCOME'), 0),
          'transactions', COUNT(DISTINCT id) FILTER (WHERE in_previous),
          'unreviewed_in', COALESCE(-SUM(amount) FILTER (WHERE in_previous AND category = 'UNCATEGORIZED' AND amount < 0), 0)
        ) FROM filtered) AS previous,
      (SELECT json_agg(c ORDER BY c.amount DESC) FROM (
          SELECT category, SUM(amount) AS amount, COUNT(DISTINCT id) AS transactions
          FROM filtered
          WHERE in_current AND category <> 'TRANSFER'
            AND NOT (category = 'UNCATEGORIZED' AND amount < 0)
          GROUP BY category
        ) c) AS by_category,
      (SELECT json_agg(s ORDER BY s.bucket_start) FROM (
          SELECT bucket_start, SUM(amount) AS spend
          FROM spend_rows
          WHERE in_current
          GROUP BY bucket_start
        ) s) AS series,
      (SELECT json_agg(m ORDER BY m.amount DESC) FROM (
          SELECT merchant, SUM(amount) AS amount, COUNT(DISTINCT id) AS transactions
          FROM spend_rows
          WHERE in_current AND merchant <> ''
          GROUP BY merchant
          ORDER BY SUM(amount) DESC
          LIMIT 10
        ) m) AS top_merchants,
      (SELECT json_agg(DISTINCT to_char(t.date, 'YYYY-MM')) FROM "Transaction" t
        JOIN "Account" a ON a.id = t."accountId"
        WHERE a."userId" = ${userId}) AS available_months
  `;

  const totals: DashboardTotals = {
    spend: num(row?.totals?.spend),
    income: num(row?.totals?.income),
    net: 0,
    transactions: Number(row?.totals?.transactions ?? 0),
    unreviewedIn: num(row?.totals?.unreviewed_in),
  };
  totals.net = Math.round((totals.income - totals.spend) * 100) / 100;

  const previous: DashboardTotals = {
    spend: num(row?.previous?.spend),
    income: num(row?.previous?.income),
    net: 0,
    transactions: Number(row?.previous?.transactions ?? 0),
    unreviewedIn: num(row?.previous?.unreviewed_in),
  };
  previous.net = Math.round((previous.income - previous.spend) * 100) / 100;

  const byCategoryRaw = (row?.by_category ?? []).map((c) => ({
    category: c.category,
    amount: num(c.amount),
    transactions: Number(c.transactions),
  }));
  // Share is of gross spending, so a negative net category (a refund exceeding
  // the month's purchases) does not produce a nonsense percentage.
  const grossSpend = byCategoryRaw
    .filter((c) => c.category !== 'INCOME' && c.amount > 0)
    .reduce((sum, c) => sum + c.amount, 0);

  return {
    totals,
    previous,
    deltas: {
      spend: percentageChange(totals.spend, previous.spend),
      income: percentageChange(totals.income, previous.income),
    },
    byCategory: byCategoryRaw.map((c) => ({
      ...c,
      share: grossSpend > 0 && c.amount > 0 ? Math.round((c.amount / grossSpend) * 1000) / 10 : 0,
    })),
    series: (row?.series ?? []).map((s) => ({ date: s.bucket_start, spend: num(s.spend) })),
    topMerchants: (row?.top_merchants ?? []).map((m) => ({
      merchant: m.merchant,
      amount: num(m.amount),
      transactions: Number(m.transactions),
    })),
    availableMonths: [...(row?.available_months ?? [])].sort(),
  };
}
