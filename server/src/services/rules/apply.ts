/**
 * Runs the deterministic engine against the database.
 *
 * Kept separate from engine.ts so the matching logic stays pure and testable;
 * everything that touches Prisma lives here.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { DEFAULT_RULES } from './defaults';
import { runEngine, type EngineRule, type EngineTransaction } from './engine';

export interface ApplyOptions {
  /** Restrict to one user's transactions. */
  userId: string;
}

export interface ApplySummary {
  considered: number;
  /** Rows whose category the engine changed. */
  categorized: number;
  transferPairs: number;
  refundLinks: number;
  /** Rows still UNCATEGORIZED after the pass — Phase 4's queue. */
  uncategorized: number;
  /** Rows left alone because a human had already set them. */
  manual: number;
  byCategory: Record<string, number>;
}

/**
 * Inserts any built-in rules that are not in the table yet.
 *
 * Idempotent, so it is safe to call from the seed and from the re-apply script.
 * Built-ins are identified by a null userId plus their pattern.
 */
export async function ensureDefaultRules(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.rule.findMany({
    where: { userId: null },
    select: { pattern: true },
  });
  const known = new Set(existing.map((r) => r.pattern));
  const missing = DEFAULT_RULES.filter((rule) => !known.has(rule.pattern));

  if (missing.length > 0) {
    await prisma.rule.createMany({
      data: missing.map((rule) => ({
        userId: null,
        pattern: rule.pattern,
        category: rule.category,
        priority: rule.priority,
        learnedFromOverride: false,
      })),
    });
  }

  return missing.length;
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Categorizes a user's transactions and writes the results.
 *
 * The whole set is loaded rather than just the newly imported rows, because
 * transfer and refund matching each need to see the other side of a pair — which
 * may sit on a different account, or weeks earlier in an import that already
 * happened.
 */
export async function applyRuleEngine(
  prisma: PrismaClient,
  { userId }: ApplyOptions,
): Promise<ApplySummary> {
  const [ruleRows, transactionRows] = await Promise.all([
    prisma.rule.findMany({
      where: { OR: [{ userId }, { userId: null }] },
      select: {
        id: true,
        pattern: true,
        category: true,
        priority: true,
        userId: true,
        learnedFromOverride: true,
      },
    }),
    prisma.transaction.findMany({
      where: { account: { userId } },
      select: {
        id: true,
        accountId: true,
        date: true,
        normalizedMerchant: true,
        amount: true,
        category: true,
        confidence: true,
        source: true,
      },
    }),
  ]);

  const rules: EngineRule[] = ruleRows;
  const transactions: EngineTransaction[] = transactionRows.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: toIso(t.date),
    normalizedMerchant: t.normalizedMerchant,
    amount: Number(t.amount),
    category: t.category,
    confidence: t.confidence,
    source: t.source,
  }));

  const outcome = runEngine(transactions, rules);
  const before = new Map(transactions.map((t) => [t.id, t]));

  const changed = outcome.results.filter((result) => {
    const original = before.get(result.transactionId)!;
    return original.source !== 'MANUAL' && original.category !== result.category;
  });

  await prisma.$transaction(async (tx) => {
    // Clear the previous pass's links so a re-run cannot leave a stale pairing
    // behind when the data underneath it has changed.
    await tx.transaction.updateMany({
      where: { account: { userId }, NOT: { transferPairId: null } },
      data: { transferPairId: null },
    });
    await tx.transaction.updateMany({
      where: { account: { userId }, NOT: { linkedRefundId: null } },
      data: { linkedRefundId: null },
    });

    for (const result of outcome.results) {
      const original = before.get(result.transactionId)!;
      if (original.source === 'MANUAL') continue;

      await tx.transaction.update({
        where: { id: result.transactionId },
        data: {
          category: result.category,
          confidence: result.confidence,
          source: result.source,
          transferPairId: result.transferPairId ?? null,
          linkedRefundId: result.linkedRefundId ?? null,
        },
      });
    }
  });

  const byCategory: Record<string, number> = {};
  outcome.results.forEach((r) => {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  });

  return {
    considered: transactions.length,
    categorized: changed.length,
    transferPairs: outcome.transferPairs.length,
    refundLinks: outcome.refundLinks.length,
    uncategorized: outcome.results.filter((r) => r.category === 'UNCATEGORIZED').length,
    manual: transactions.filter((t) => t.source === 'MANUAL').length,
    byCategory,
  };
}

/** Resolves the owning user of an account, for the post-commit pass. */
export async function userIdForAccount(
  prisma: PrismaClient,
  accountId: string,
): Promise<string | null> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { userId: true },
  });
  return account?.userId ?? null;
}
