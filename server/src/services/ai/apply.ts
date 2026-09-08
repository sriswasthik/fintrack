/**
 * Runs the LLM fallback over whatever the rule engine left unresolved, and
 * writes the results.
 *
 * The cache is the point of this file as much as the model call is: every
 * decision is memoized by normalized merchant, so the same merchant is never
 * sent to the model twice however many transactions it has, or however many
 * times an overlapping export is imported (PROJECT_CONTEXT.md §7).
 */
import type { PrismaClient } from '../../generated/prisma/client';
import type { Category } from '../../generated/prisma/enums';
import { LOW_CONFIDENCE_THRESHOLD, type MerchantCategorizer } from './categorize';

export interface ApplyLlmOptions {
  userId: string;
  categorizer: MerchantCategorizer;
  /** Skip the cache and re-ask the model. Off by default. */
  ignoreCache?: boolean;
}

export interface ApplyLlmSummary {
  /** Transactions that were UNCATEGORIZED when the pass started. */
  unresolved: number;
  /** Distinct merchants behind them. */
  distinctMerchants: number;
  /** Merchants answered from the cache without a model call. */
  fromCache: number;
  /** Merchants sent to the model. */
  sentToModel: number;
  /** Transactions given a category by this pass. */
  categorized: number;
  /** Transactions stored with a category but below the confidence threshold. */
  lowConfidence: number;
  /** Merchants whose answer failed validation and were left alone. */
  rejected: number;
  /** Transactions still UNCATEGORIZED afterwards — all of them in the review queue. */
  stillUnresolved: number;
}

/**
 * Categorizes every UNCATEGORIZED transaction the rule engine left behind.
 *
 * Only rows with `source` RULE are touched. A MANUAL row is a human's decision
 * and is never revisited (§8 case 12); an LLM row has already been through here.
 */
export async function applyLlmCategorization(
  prisma: PrismaClient,
  { userId, categorizer, ignoreCache = false }: ApplyLlmOptions,
): Promise<ApplyLlmSummary> {
  const unresolved = await prisma.transaction.findMany({
    where: { account: { userId }, category: 'UNCATEGORIZED', source: 'RULE' },
    select: { id: true, normalizedMerchant: true },
  });

  const merchants = [...new Set(unresolved.map((t) => t.normalizedMerchant))].sort();

  const cached = ignoreCache
    ? []
    : await prisma.merchantCategoryCache.findMany({
        where: { normalizedMerchant: { in: merchants } },
      });
  const cachedByMerchant = new Map(
    cached.map((entry) => [
      entry.normalizedMerchant,
      { category: entry.category, confidence: entry.confidence },
    ]),
  );

  const toAsk = merchants.filter((merchant) => !cachedByMerchant.has(merchant));
  const outcomes = toAsk.length > 0 ? await categorizer.categorize(toAsk) : [];

  const decisions = new Map<string, { category: Category; confidence: number }>();
  cachedByMerchant.forEach((value, merchant) => decisions.set(merchant, value));

  let rejected = 0;
  for (const outcome of outcomes) {
    if (outcome.rejected || outcome.category === 'UNCATEGORIZED') {
      // Nothing is written for a rejected answer — not to the transaction and
      // not to the cache, so a later run can try again once the cause is fixed.
      rejected += 1;
      continue;
    }
    decisions.set(outcome.merchant, {
      category: outcome.category,
      confidence: outcome.confidence,
    });

    await prisma.merchantCategoryCache.upsert({
      where: { normalizedMerchant: outcome.merchant },
      create: {
        normalizedMerchant: outcome.merchant,
        category: outcome.category,
        confidence: outcome.confidence,
      },
      update: { category: outcome.category, confidence: outcome.confidence },
    });
  }

  let categorized = 0;
  let lowConfidence = 0;

  for (const transaction of unresolved) {
    const decision = decisions.get(transaction.normalizedMerchant);
    if (!decision) continue;

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        category: decision.category,
        confidence: decision.confidence,
        source: 'LLM',
      },
    });
    categorized += 1;
    if (decision.confidence < LOW_CONFIDENCE_THRESHOLD) lowConfidence += 1;
  }

  return {
    unresolved: unresolved.length,
    distinctMerchants: merchants.length,
    fromCache: cachedByMerchant.size,
    sentToModel: toAsk.length,
    categorized,
    lowConfidence,
    rejected,
    stillUnresolved: unresolved.length - categorized,
  };
}
