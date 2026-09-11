/**
 * The running totals, computed rather than stored.
 *
 * Deliberately not columns on `Payee`. A stored total is a second copy of a
 * fact, and the moment a transaction is recategorized, split, deleted or
 * re-imported the copy is wrong with nothing to say so. The query below is one
 * grouped scan over a user's own rows; correctness is worth more than the
 * microseconds.
 *
 * Sign convention, which the whole app shares: **debit-positive**. Money
 * leaving the account is positive, money arriving is negative. So:
 *
 *   paid     = the positive amounts, summed
 *   received = the negative amounts, summed and flipped
 *   net      = paid − received
 *
 * A net of zero means the two of you are square — which is exactly what a
 * lent-and-returned round trip should read as.
 */
import { Prisma } from '../../generated/prisma/client';
import type { PrismaClient } from '../../generated/prisma/client';

/** What a payee row carries in a listing. */
export interface PayeeAggregate {
  id: string;
  displayName: string;
  upiVpa: string | null;
  phone: string | null;
  type: 'PERSON' | 'BUSINESS';
  /** Total that left the account towards this payee. */
  paid: number;
  /** Total that arrived from this payee. */
  received: number;
  /** `paid - received`. Positive: you are out of pocket. */
  net: number;
  transactions: number;
  /** ISO date of the most recent transaction, or null if there are none. */
  lastTransactionAt: string | null;
  firstTransactionAt: string | null;
}

/** The columns a caller may sort by. */
export const PAYEE_SORTS = [
  'name',
  'paid',
  'received',
  'net',
  'lastTransactionAt',
  'transactions',
] as const;
export type PayeeSort = (typeof PAYEE_SORTS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ListPayeesOptions {
  userId: string;
  /** Case-insensitive substring of the display name, UPI address or phone. */
  search?: string;
  sort?: PayeeSort;
  direction?: SortDirection;
}

/**
 * Maps a sort name to the SQL it orders by.
 *
 * The aggregates are bare output-column names, which Postgres resolves to the
 * SELECT list. `name` cannot be: wrapping an alias in `lower(...)` makes it an
 * *expression*, and an expression is resolved against the input columns, where
 * `display_name` does not exist. So the name sorts on the underlying column.
 */
const SORT_COLUMN: Record<PayeeSort, string> = {
  name: 'lower(p."displayName")',
  paid: 'paid',
  received: 'received',
  net: 'net',
  lastTransactionAt: 'last_transaction_at',
  transactions: 'transactions',
};

/** The tie-break, for the same reason: an expression, so a real column. */
const TIE_BREAK = 'lower(p."displayName") ASC';

interface AggregateRow {
  id: string;
  display_name: string;
  upi_vpa: string | null;
  phone: string | null;
  type: 'PERSON' | 'BUSINESS';
  paid: Prisma.Decimal | number | null;
  received: Prisma.Decimal | number | null;
  net: Prisma.Decimal | number | null;
  transactions: bigint | number;
  last_transaction_at: Date | null;
  first_transaction_at: Date | null;
}

const money = (value: Prisma.Decimal | number | null): number =>
  Math.round(Number(value ?? 0) * 100) / 100;

const isoDate = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

function toAggregate(row: AggregateRow): PayeeAggregate {
  return {
    id: row.id,
    displayName: row.display_name,
    upiVpa: row.upi_vpa,
    phone: row.phone,
    type: row.type,
    paid: money(row.paid),
    received: money(row.received),
    net: money(row.net),
    transactions: Number(row.transactions),
    lastTransactionAt: isoDate(row.last_transaction_at),
    firstTransactionAt: isoDate(row.first_transaction_at),
  };
}

/**
 * Every payee the user has, with their totals.
 *
 * The join is scoped by `Payee.userId` *and* by the owning user of each
 * transaction's account. Belt and braces: a payee can only be reached through
 * its own user, and a transaction can only contribute to a payee owned by the
 * same person, so no arrangement of ids leaks one user's rows into another's
 * totals.
 */
export async function listPayees(
  prisma: PrismaClient,
  { userId, search, sort = 'net', direction = 'desc' }: ListPayeesOptions,
): Promise<PayeeAggregate[]> {
  const term = search?.trim() ? `%${search.trim()}%` : null;
  // Interpolated, not parameterized: both halves come from a fixed allow-list
  // (`SORT_COLUMN`, and the two literals below), never from the request.
  const orderBy = Prisma.raw(
    `${SORT_COLUMN[sort]} ${direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, ${TIE_BREAK}`,
  );

  const rows = await prisma.$queryRaw<AggregateRow[]>`
    SELECT
      p.id,
      p."displayName" AS display_name,
      p."upiVpa"      AS upi_vpa,
      p.phone,
      p.type,
      COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0)  AS paid,
      COALESCE(-SUM(t.amount) FILTER (WHERE t.amount < 0), 0) AS received,
      COALESCE(SUM(t.amount), 0)                              AS net,
      COUNT(t.id)                                             AS transactions,
      MAX(t.date)                                             AS last_transaction_at,
      MIN(t.date)                                             AS first_transaction_at
    FROM "Payee" p
    LEFT JOIN "Transaction" t ON t."payeeId" = p.id
    LEFT JOIN "Account" a ON a.id = t."accountId" AND a."userId" = ${userId}
    WHERE p."userId" = ${userId}
      AND (t.id IS NULL OR a.id IS NOT NULL)
      AND (
        ${term}::text IS NULL
        OR p."displayName" ILIKE ${term}
        OR p."upiVpa" ILIKE ${term}
        OR p.phone ILIKE ${term}
      )
    GROUP BY p.id, p."displayName", p."upiVpa", p.phone, p.type
    ORDER BY ${orderBy}
  `;

  return rows.map(toAggregate);
}

/** One transaction in a payee's history. */
export interface PayeeTransaction {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  description: string;
  normalizedMerchant: string;
  amount: number;
  category: string;
  /** 'paid' when money left the account, 'received' when it arrived. */
  direction: 'paid' | 'received';
}

export interface PayeeDetail extends PayeeAggregate {
  transactionHistory: PayeeTransaction[];
}

/**
 * One payee, with every transaction that rolls up into their totals.
 *
 * Returns null when the payee does not exist *or* belongs to someone else —
 * the caller turns both into the same 404, so an id probe cannot tell the
 * difference between "no such payee" and "not yours".
 */
export async function getPayee(
  prisma: PrismaClient,
  { userId, payeeId }: { userId: string; payeeId: string },
): Promise<PayeeDetail | null> {
  const [aggregate] = await prisma.$queryRaw<AggregateRow[]>`
    SELECT
      p.id,
      p."displayName" AS display_name,
      p."upiVpa"      AS upi_vpa,
      p.phone,
      p.type,
      COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0)  AS paid,
      COALESCE(-SUM(t.amount) FILTER (WHERE t.amount < 0), 0) AS received,
      COALESCE(SUM(t.amount), 0)                              AS net,
      COUNT(t.id)                                             AS transactions,
      MAX(t.date)                                             AS last_transaction_at,
      MIN(t.date)                                             AS first_transaction_at
    FROM "Payee" p
    LEFT JOIN "Transaction" t ON t."payeeId" = p.id
    LEFT JOIN "Account" a ON a.id = t."accountId" AND a."userId" = ${userId}
    WHERE p."userId" = ${userId}
      AND p.id = ${payeeId}
      AND (t.id IS NULL OR a.id IS NOT NULL)
    GROUP BY p.id, p."displayName", p."upiVpa", p.phone, p.type
  `;

  if (!aggregate) return null;

  const history = await prisma.transaction.findMany({
    where: { payeeId, account: { userId } },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      accountId: true,
      date: true,
      description: true,
      normalizedMerchant: true,
      amount: true,
      category: true,
      account: { select: { name: true } },
    },
  });

  return {
    ...toAggregate(aggregate),
    transactionHistory: history.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      accountName: t.account.name,
      date: t.date.toISOString().slice(0, 10),
      description: t.description,
      normalizedMerchant: t.normalizedMerchant,
      amount: Number(t.amount),
      category: t.category,
      direction: Number(t.amount) >= 0 ? 'paid' : 'received',
    })),
  };
}
