/**
 * Debits, credits and net over an arbitrary window.
 *
 * One aggregation query, one scan. This is deliberately a *cashflow* view and
 * not a second copy of the dashboard's: it asks what moved in and out of the
 * account, so a transfer counts (the money really did move) and nothing is
 * netted against anything else. The dashboard answers a different question —
 * what did you *spend* — which is why it excludes transfers and folds refunds
 * back into the category they reverse.
 *
 * Sign convention, shared with the rest of the app: **debit-positive**. Money
 * leaving is a positive amount, money arriving is negative. So:
 *
 *   totalDebits  = the positive amounts, summed
 *   totalCredits = the negative amounts, summed and flipped to a magnitude
 *   net          = SUM(amount), which is exactly debits − credits
 *
 * A positive net means more went out than came in. That is the same direction
 * as `Payee.net` from Phase 15 and as every stored amount, so a client can
 * colour all of them by sign with one rule and no special cases.
 *
 * Splits are not expanded. A split's parts sum to its parent, so counting the
 * parent alone gives the same money and keeps `transactionCount` a count of
 * transactions rather than of rows in a join.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/client';

export interface RangeTotals {
  /** Money out, as a positive magnitude. */
  totalDebits: number;
  /** Money in, as a positive magnitude. */
  totalCredits: number;
  /** `totalDebits - totalCredits`. Positive: more left than arrived. */
  net: number;
  transactionCount: number;
}

export interface TotalsQuery {
  userId: string;
  /** Inclusive start. */
  from: Date;
  /** Exclusive end. */
  to: Date;
  accountId?: string;
}

interface TotalsRow {
  total_debits: Prisma.Decimal | number | null;
  total_credits: Prisma.Decimal | number | null;
  net: Prisma.Decimal | number | null;
  transaction_count: bigint | number;
}

const money = (value: Prisma.Decimal | number | null): number =>
  Math.round(Number(value ?? 0) * 100) / 100;

export async function aggregateTotals(
  prisma: PrismaClient,
  { userId, from, to, accountId }: TotalsQuery,
): Promise<RangeTotals> {
  // `null` means "no filter", passed as a parameter rather than interpolated so
  // this stays a prepared statement.
  const accountFilter = accountId ?? null;

  const [row] = await prisma.$queryRaw<TotalsRow[]>`
    SELECT
      COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0)  AS total_debits,
      COALESCE(-SUM(t.amount) FILTER (WHERE t.amount < 0), 0) AS total_credits,
      COALESCE(SUM(t.amount), 0)                              AS net,
      COUNT(t.id)                                             AS transaction_count
    FROM "Transaction" t
    JOIN "Account" a ON a.id = t."accountId"
    WHERE a."userId" = ${userId}
      AND t.date >= ${from}
      AND t.date < ${to}
      AND (${accountFilter}::text IS NULL OR t."accountId" = ${accountFilter})
  `;

  return {
    totalDebits: money(row?.total_debits ?? 0),
    totalCredits: money(row?.total_credits ?? 0),
    net: money(row?.net ?? 0),
    transactionCount: Number(row?.transaction_count ?? 0),
  };
}
