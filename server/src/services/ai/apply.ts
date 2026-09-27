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
import { classifyCounterparty } from '../rules/counterparty';
import {
  CategorizerConfigurationError,
  LOW_CONFIDENCE_THRESHOLD,
  type MerchantCategorizer,
} from './categorize';

export interface ApplyLlmOptions {
  userId: string;
  categorizer: MerchantCategorizer;
  /** Skip the cache and re-ask the model. Off by default. */
  ignoreCache?: boolean;
}

export interface ApplyLlmSummary {
  /** Transactions that were UNCATEGORIZED when the pass started. */
  unresolved: number;
  /**
   * Of those, payments to a person, which are never sent to the model: a
   * person's name says nothing about what the money was for, and it is not the
   * model's to see. They stay in the review queue.
   */
  skippedPeople: number;
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
  const pending = await prisma.transaction.findMany({
    where: { account: { userId }, category: 'UNCATEGORIZED', source: 'RULE' },
    select: { id: true, normalizedMerchant: true, counterpartyRaw: true, upiVpa: true },
  });

  const unresolved = pending.filter((t) => classifyCounterparty(t).type !== 'PERSON');
  const skippedPeople = pending.length - unresolved.length;

  const merchants = [...new Set(unresolved.map((t) => t.normalizedMerchant))].sort();
  if (merchants.length === 0) {
    return {
      unresolved: pending.length,
      skippedPeople,
      distinctMerchants: 0,
      fromCache: 0,
      sentToModel: 0,
      categorized: 0,
      lowConfidence: 0,
      rejected: 0,
      stillUnresolved: pending.length,
    };
  }

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
    unresolved: pending.length,
    skippedPeople,
    distinctMerchants: merchants.length,
    fromCache: cachedByMerchant.size,
    sentToModel: toAsk.length,
    categorized,
    lowConfidence,
    rejected,
    stillUnresolved: pending.length - categorized,
  };
}

/** What the AI pass did after an import, for the client to report. */
export type LlmPassResult =
  | ({ status: 'done' } & ApplyLlmSummary)
  /** Switched off with AI_CATEGORIZATION=off. */
  | { status: 'off' }
  /** No usable credentials, or the account cannot use the model. */
  | { status: 'unavailable'; reason: string };

/**
 * Whether unresolved merchants may be sent to the model at all.
 *
 * On unless AI_CATEGORIZATION=off. The switch exists for an operator who
 * wants the monthly summary (which only ever sees totals) without merchant
 * names leaving the server.
 */
export function aiCategorizationEnabled(): boolean {
  return process.env.AI_CATEGORIZATION !== 'off';
}

/**
 * The LLM fallback as a step of an import: runs when it is switched on, and
 * reports rather than throws when it cannot run.
 *
 * A missing key must not fail an import — the rows are already stored and the
 * rule engine has already done its part — but it must not be silent either,
 * or categorization would quietly stop with nothing to say why. So the reason
 * is logged in full for the operator and summarised for the user.
 */
export async function runLlmPass(
  prisma: PrismaClient,
  options: ApplyLlmOptions,
): Promise<LlmPassResult> {
  if (!aiCategorizationEnabled()) return { status: 'off' };
  try {
    return { status: 'done', ...(await applyLlmCategorization(prisma, options)) };
  } catch (error) {
    if (!(error instanceof CategorizerConfigurationError)) throw error;
    console.warn(`AI categorization unavailable: ${error.message}`);
    return {
      status: 'unavailable',
      reason: 'AI categorization is not configured on this server.',
    };
  }
}
