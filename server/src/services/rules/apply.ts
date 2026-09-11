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

/** What a sync of the built-in rules changed. */
export interface DefaultRuleSync {
  added: number;
  /** Rules whose category or priority moved in `defaults.ts`. */
  updated: number;
  /** Rules removed from `defaults.ts` and deleted from the table. */
  removed: number;
}

/**
 * Brings the built-in rules in the table into line with `defaults.ts`.
 *
 * Idempotent, so it is safe to call from the seed and from the re-apply script.
 * Built-ins are identified by a null userId plus their pattern; a user's own
 * learned rules have a userId and are never touched here.
 *
 * All three directions matter, and only the first used to be handled:
 *
 *   * **added** — a new rule in `defaults.ts`.
 *   * **updated** — the same pattern with a different category or priority.
 *     Phase 14 moved `^AMAZON PRIME` and `^SPENCERS HYPER` into the
 *     disambiguation band precisely so they would stop losing a coin toss
 *     against a broader rule; leaving the old priority in the database would
 *     have kept the coin toss and made the fix true only in the tests.
 *   * **removed** — a pattern `defaults.ts` no longer has. An insert-only sync
 *     leaves it behind forever, still matching, with nothing in the source to
 *     say why a merchant is being categorized the way it is.
 */
export async function ensureDefaultRules(prisma: PrismaClient): Promise<DefaultRuleSync> {
  const existing = await prisma.rule.findMany({
    where: { userId: null },
    select: { id: true, pattern: true, category: true, priority: true },
  });
  const byPattern = new Map(existing.map((r) => [r.pattern, r]));
  const wanted = new Map(DEFAULT_RULES.map((r) => [r.pattern, r]));

  const missing = DEFAULT_RULES.filter((rule) => !byPattern.has(rule.pattern));
  const stale = DEFAULT_RULES.filter((rule) => {
    const row = byPattern.get(rule.pattern);
    return row && (row.category !== rule.category || row.priority !== rule.priority);
  });
  const retired = existing.filter((row) => !wanted.has(row.pattern));

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

  for (const rule of stale) {
    await prisma.rule.update({
      where: { id: byPattern.get(rule.pattern)!.id },
      data: { category: rule.category, priority: rule.priority },
    });
  }

  if (retired.length > 0) {
    await prisma.rule.deleteMany({ where: { id: { in: retired.map((r) => r.id) } } });
  }

  return { added: missing.length, updated: stale.length, removed: retired.length };
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
