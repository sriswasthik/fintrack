/**
 * Storing and serving monthly summaries.
 *
 * A summary is expensive relative to what it is — one model call for a
 * paragraph that will not change until the underlying transactions do — so it
 * is written once per user-month and read back from `MonthlySummary` after
 * that. Regenerating is an explicit act, never a side effect of looking at the
 * page.
 *
 * The stats are still recomputed on every read, cheaply, for one reason: it is
 * the only way to notice that an import has moved the numbers out from under a
 * paragraph that is now quietly wrong. When that happens the summary is served
 * with `stale: true` rather than silently, and the client offers to redo it.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  renderFallback,
  SummarizerConfigurationError,
  type MonthlySummarizer,
  type SummaryResult,
} from '../ai/summarize';
import { buildMonthlyStats, type MonthlyStats } from './stats';

/** What goes in the `statsSnapshot` column. */
export interface SummarySnapshot {
  stats: MonthlyStats;
  generation: {
    source: SummaryResult['source'];
    calls: number;
    rejections: string[];
  };
}

export interface MonthlySummaryRecord {
  month: string;
  content: string;
  stats: MonthlyStats;
  source: SummaryResult['source'];
  /** True when this came out of the table rather than the model. */
  cached: boolean;
  /**
   * True when the figures have moved since the text was written — a later
   * import, a recategorization, a split. The text is still shown; it is just
   * no longer describing the month the dashboard is showing.
   */
  stale: boolean;
  generatedAt: string;
  /**
   * Set when the model could not be reached at all — no API key, a rejected
   * one, a model the account cannot use. The stats are still shown, but the
   * client says why they read like a ledger entry rather than a recap, and
   * nothing is written to the cache so that fixing the credential is enough.
   */
  unavailable?: string;
}

export interface SummaryQuery {
  userId: string;
  /** YYYY-MM. */
  month: string;
}

/**
 * The figures a reader would notice changing.
 *
 * Comparing whole snapshots would call a summary stale because an anomaly
 * explanation gained a decimal place; these are the numbers the prose actually
 * commits to.
 */
function headline(stats: MonthlyStats): string {
  return JSON.stringify([
    stats.spend,
    stats.income,
    stats.net,
    stats.transactions,
    stats.savingsRate,
    stats.topCategories.map((c) => [c.category, c.amount]),
    stats.topMerchant?.merchant ?? null,
    stats.topMerchant?.amount ?? null,
  ]);
}

function readSnapshot(value: Prisma.JsonValue): SummarySnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as unknown as SummarySnapshot;
  return snapshot.stats ? snapshot : null;
}

/**
 * Runs the summarizer, degrading rather than failing when it is not configured.
 *
 * A misconfiguration is not hidden — it comes back named, and the caller
 * declines to cache the result — but it does not take the page down with it.
 * A month is still worth showing without a paragraph about it.
 */
async function generate(
  summarizer: MonthlySummarizer,
  stats: MonthlyStats,
): Promise<{ result: SummaryResult; unavailable?: string }> {
  try {
    return { result: await summarizer.summarize(stats) };
  } catch (error) {
    if (error instanceof SummarizerConfigurationError) {
      return {
        result: { content: renderFallback(stats), source: 'fallback', calls: 0, rejections: [] },
        unavailable: `The summary model is not available: ${error.message}`,
      };
    }
    throw error;
  }
}

async function persist(
  prisma: PrismaClient,
  { userId, month }: SummaryQuery,
  stats: MonthlyStats,
  result: SummaryResult,
): Promise<MonthlySummaryRecord> {
  const snapshot: SummarySnapshot = {
    stats,
    generation: { source: result.source, calls: result.calls, rejections: result.rejections },
  };
  const data = {
    content: result.content,
    statsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
  };

  const row = await prisma.monthlySummary.upsert({
    where: { userId_month: { userId, month } },
    create: { userId, month, ...data },
    update: data,
  });

  return {
    month,
    content: row.content,
    stats,
    source: result.source,
    cached: false,
    stale: false,
    generatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The cached summary for a month, generating one if there is none.
 *
 * The model is called at most once here, and only when nothing is stored.
 */
export async function getMonthlySummary(
  prisma: PrismaClient,
  summarizer: MonthlySummarizer,
  query: SummaryQuery,
): Promise<MonthlySummaryRecord> {
  const { userId, month } = query;

  const [stats, existing] = await Promise.all([
    buildMonthlyStats(prisma, query),
    prisma.monthlySummary.findUnique({ where: { userId_month: { userId, month } } }),
  ]);

  if (existing) {
    const snapshot = readSnapshot(existing.statsSnapshot);
    return {
      month,
      content: existing.content,
      stats,
      source: snapshot?.generation.source ?? 'model',
      cached: true,
      stale: snapshot === null || headline(snapshot.stats) !== headline(stats),
      generatedAt: existing.updatedAt.toISOString(),
    };
  }

  return write(prisma, query, stats, await generate(summarizer, stats));
}

/** Writes a fresh summary over whatever was there, always calling the model. */
export async function regenerateMonthlySummary(
  prisma: PrismaClient,
  summarizer: MonthlySummarizer,
  query: SummaryQuery,
): Promise<MonthlySummaryRecord> {
  const stats = await buildMonthlyStats(prisma, query);
  return write(prisma, query, stats, await generate(summarizer, stats));
}

/** Persists a generated summary, unless the model was never reached. */
async function write(
  prisma: PrismaClient,
  query: SummaryQuery,
  stats: MonthlyStats,
  { result, unavailable }: { result: SummaryResult; unavailable?: string },
): Promise<MonthlySummaryRecord> {
  if (unavailable) {
    return {
      month: query.month,
      content: result.content,
      stats,
      source: result.source,
      cached: false,
      stale: false,
      generatedAt: new Date().toISOString(),
      unavailable,
    };
  }
  return persist(prisma, query, stats, result);
}
