/**
 * Turning counterparties into a running ledger.
 *
 * Runs after the rule engine on every import and re-categorization, and is
 * idempotent: a transaction already pointing at the right payee is left alone,
 * and re-running over the whole set produces the same rows.
 *
 * Matching is by UPI address first and by name second, in that order and not
 * the other way round. Two people are called Ramesh Kumar; `rameshkumar@ybl` is
 * one account. Where a payee has been seen with an address once, a later
 * transaction carrying the same address joins it even if the name is spelled
 * differently — which is the normal case, because banks and UPI apps disagree
 * about capitalisation and initials constantly.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import {
  hasNoCounterparty,
  matchKeyFor,
  payeeTypeOf,
  resolveCounterparty,
  type ResolvedCounterparty,
} from './counterparty';

export interface ResolveOptions {
  userId: string;
}

export interface ResolveSummary {
  /** Transactions considered — everything the user owns. */
  considered: number;
  /** Transactions that now point at a payee and did not before. */
  linked: number;
  /** Payees created by this pass. */
  created: number;
  /** Transactions deliberately left with no payee (a fee, an ATM withdrawal). */
  skipped: number;
}

/** A payee as it sits in the table, plus the keys used to match against it. */
interface PayeeRow {
  id: string;
  displayName: string;
  upiVpa: string | null;
  phone: string | null;
}

/**
 * Resolves every one of a user's transactions to a payee.
 *
 * Loads the whole set rather than only new rows: an address seen for the first
 * time today identifies transactions imported months ago, and leaving those
 * behind would mean the ledger's answer depends on import order.
 */
export async function resolvePayees(
  prisma: PrismaClient,
  { userId }: ResolveOptions,
): Promise<ResolveSummary> {
  const transactions = await prisma.transaction.findMany({
    where: { account: { userId } },
    select: {
      id: true,
      description: true,
      rawMerchant: true,
      normalizedMerchant: true,
      counterpartyRaw: true,
      upiVpa: true,
      category: true,
      payeeId: true,
    },
    orderBy: { date: 'asc' },
  });

  const existing = await prisma.payee.findMany({
    where: { userId },
    select: { id: true, displayName: true, upiVpa: true, phone: true },
  });

  const byVpa = new Map<string, PayeeRow>();
  const byName = new Map<string, PayeeRow>();
  for (const payee of existing) {
    if (payee.upiVpa) byVpa.set(payee.upiVpa, payee);
    byName.set(matchKeyFor(payee.displayName), payee);
  }

  const summary: ResolveSummary = {
    considered: transactions.length,
    linked: 0,
    created: 0,
    skipped: 0,
  };

  /** transactionId -> payeeId, for the rows whose link needs writing. */
  const links = new Map<string, string>();
  /** Payees to create, and the addresses/phones learned about existing ones. */
  const enrich = new Map<string, { upiVpa?: string; phone?: string }>();

  for (const transaction of transactions) {
    if (hasNoCounterparty(transaction.category, transaction.normalizedMerchant)) {
      summary.skipped += 1;
      continue;
    }

    const counterparty = resolveCounterparty(transaction);
    if (!counterparty) {
      summary.skipped += 1;
      continue;
    }

    const match = findMatch(counterparty, byVpa, byName);

    if (match) {
      // A payee first seen without an address gains one the moment a
      // transaction carries it, so later rows can match on the stronger key.
      if (counterparty.upiVpa && !match.upiVpa) {
        match.upiVpa = counterparty.upiVpa;
        match.phone = counterparty.phone;
        byVpa.set(counterparty.upiVpa, match);
        enrich.set(match.id, {
          upiVpa: counterparty.upiVpa,
          ...(counterparty.phone ? { phone: counterparty.phone } : {}),
        });
      }
      if (transaction.payeeId !== match.id) links.set(transaction.id, match.id);
      continue;
    }

    const created = await prisma.payee.create({
      data: {
        userId,
        displayName: counterparty.displayName,
        upiVpa: counterparty.upiVpa,
        phone: counterparty.phone,
        type: payeeTypeOf(counterparty.type),
      },
      select: { id: true, displayName: true, upiVpa: true, phone: true },
    });
    summary.created += 1;

    if (created.upiVpa) byVpa.set(created.upiVpa, created);
    byName.set(counterparty.matchKey, created);
    links.set(transaction.id, created.id);
  }

  for (const [payeeId, data] of enrich) {
    await prisma.payee.update({ where: { id: payeeId }, data });
  }

  // Grouped by payee so a hundred transactions with one counterparty is one
  // statement rather than a hundred.
  const byPayee = new Map<string, string[]>();
  for (const [transactionId, payeeId] of links) {
    const list = byPayee.get(payeeId);
    if (list) list.push(transactionId);
    else byPayee.set(payeeId, [transactionId]);
  }

  for (const [payeeId, transactionIds] of byPayee) {
    await prisma.transaction.updateMany({
      where: { id: { in: transactionIds } },
      data: { payeeId },
    });
  }

  summary.linked = links.size;
  return summary;
}

/** UPI address first, then the name. Never the other way round. */
function findMatch(
  counterparty: ResolvedCounterparty,
  byVpa: Map<string, PayeeRow>,
  byName: Map<string, PayeeRow>,
): PayeeRow | undefined {
  if (counterparty.upiVpa) {
    const match = byVpa.get(counterparty.upiVpa);
    if (match) return match;
  }
  return byName.get(counterparty.matchKey);
}

/** Resolves the owning user of an account, for the post-commit pass. */
export async function userIdForPayeeScope(
  prisma: PrismaClient,
  accountId: string,
): Promise<string | null> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { userId: true },
  });
  return account?.userId ?? null;
}
