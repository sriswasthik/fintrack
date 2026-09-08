/**
 * Runs anomaly detection against the database and persists the findings.
 *
 * Kept separate from detect.ts so the statistics stay pure and testable;
 * everything that touches Prisma lives here — the same split the rule engine
 * uses in services/rules/apply.ts.
 */
import type { AnomalyFlag, PrismaClient } from '../../generated/prisma/client';
import { detectAnomalies, type AnomalyTransaction, type DetectOptions } from './detect';

export interface RefreshOptions extends Omit<DetectOptions, 'month'> {
  userId: string;
  /** Calendar month to analyse, YYYY-MM. */
  month: string;
}

export interface RefreshSummary {
  month: string;
  /** Findings the detectors returned for the month. */
  detected: number;
  created: number;
  /** Existing flags whose wording or severity was refreshed in place. */
  updated: number;
  /** Flags removed because the data no longer supports them. */
  cleared: number;
}

/** Exclusive end of `month`, as a Date. */
function monthEnd(month: string): Date {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index, 1));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Loads the rows detection reasons over.
 *
 * Everything up to the end of the month is loaded, not just the lookback
 * window: "is this a *new* recurring charge" is a question about all of a
 * merchant's history, and a subscription that has been billing for two years
 * would look brand new through a six-month keyhole.
 *
 * Two shaping rules match the dashboard aggregation exactly, so the Insights
 * panel and the charts beside it can never disagree:
 *
 *   * A split transaction contributes its parts, never itself as well.
 *   * A refund is attributed to the category of the purchase it offsets, so it
 *     nets against that category instead of forming a bucket of its own.
 */
export async function loadAnomalyTransactions(
  prisma: PrismaClient,
  { userId, month }: { userId: string; month: string },
): Promise<AnomalyTransaction[]> {
  const rows = await prisma.transaction.findMany({
    where: { account: { userId }, date: { lt: monthEnd(month) } },
    select: {
      id: true,
      date: true,
      amount: true,
      category: true,
      normalizedMerchant: true,
      splits: { select: { category: true, amount: true } },
      // The link lives on the purchase and points at the refund, so the reverse
      // side is how a refund finds the purchase it offsets.
      refundFor: { select: { category: true } },
    },
    orderBy: { date: 'asc' },
  });

  return rows.flatMap((row) => {
    const base = {
      id: row.id,
      date: toIso(row.date),
      normalizedMerchant: row.normalizedMerchant,
    };

    if (row.splits.length > 0) {
      return row.splits.map((split) => ({
        ...base,
        amount: Number(split.amount),
        category: split.category,
      }));
    }

    return [
      {
        ...base,
        amount: Number(row.amount),
        category:
          row.category === 'REFUND' && row.refundFor ? row.refundFor.category : row.category,
      },
    ];
  });
}

/**
 * Re-detects a month and reconciles the stored flags with the result.
 *
 * Idempotent by design. A finding carries a fingerprint that is a function of
 * the data behind it, so a second run over unchanged transactions updates the
 * same rows rather than producing a second copy of every insight.
 *
 * A dismissed flag is never deleted, even once the finding behind it has gone.
 * Deleting it would mean the next detection pass could recreate it and put an
 * insight the user has already waved away back on their dashboard.
 */
export async function refreshAnomalies(
  prisma: PrismaClient,
  options: RefreshOptions,
): Promise<RefreshSummary> {
  const { userId, month, ...thresholds } = options;

  const transactions = await loadAnomalyTransactions(prisma, { userId, month });
  const found = detectAnomalies(transactions, { ...thresholds, month });

  // Split parts of one charge can each be flagged; the fingerprint carries the
  // category, so they stay distinct. Deduplicating defensively keeps a repeated
  // fingerprint from failing the whole batch on the unique constraint.
  const byFingerprint = new Map(found.map((anomaly) => [anomaly.fingerprint, anomaly]));

  const existing = await prisma.anomalyFlag.findMany({ where: { userId, month } });
  const known = new Map(existing.map((flag) => [flag.fingerprint, flag]));

  const stale = existing.filter(
    (flag) => !byFingerprint.has(flag.fingerprint) && flag.dismissedAt === null,
  );

  let created = 0;
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    for (const anomaly of byFingerprint.values()) {
      const previous = known.get(anomaly.fingerprint);
      const data = {
        type: anomaly.type,
        severity: anomaly.severity,
        explanation: anomaly.explanation,
        transactionId: anomaly.transactionId ?? null,
      };

      if (previous) {
        updated += 1;
        await tx.anomalyFlag.update({ where: { id: previous.id }, data });
      } else {
        created += 1;
        await tx.anomalyFlag.create({
          data: { ...data, userId, month, fingerprint: anomaly.fingerprint },
        });
      }
    }

    if (stale.length > 0) {
      await tx.anomalyFlag.deleteMany({ where: { id: { in: stale.map((flag) => flag.id) } } });
    }
  });

  return { month, detected: byFingerprint.size, created, updated, cleared: stale.length };
}

export interface Insight {
  id: string;
  type: AnomalyFlag['type'];
  severity: AnomalyFlag['severity'];
  month: string;
  explanation: string;
  transactionId: string | null;
  createdAt: string;
  transaction: {
    id: string;
    date: string;
    description: string;
    merchant: string;
    amount: number;
    category: AnomalyTransaction['category'];
  } | null;
}

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

/**
 * The active flags for a month — most severe first, and never one the user has
 * already dismissed.
 */
export async function listInsights(
  prisma: PrismaClient,
  { userId, month }: { userId: string; month: string },
): Promise<Insight[]> {
  const flags = await prisma.anomalyFlag.findMany({
    where: { userId, month, dismissedAt: null },
    include: {
      transaction: {
        select: {
          id: true,
          date: true,
          description: true,
          normalizedMerchant: true,
          amount: true,
          category: true,
        },
      },
    },
  });

  return flags
    .map((flag) => ({
      id: flag.id,
      type: flag.type,
      severity: flag.severity,
      month: flag.month,
      explanation: flag.explanation,
      transactionId: flag.transactionId,
      createdAt: flag.createdAt.toISOString(),
      transaction: flag.transaction
        ? {
            id: flag.transaction.id,
            date: toIso(flag.transaction.date),
            description: flag.transaction.description,
            merchant: flag.transaction.normalizedMerchant,
            amount: Number(flag.transaction.amount),
            category: flag.transaction.category,
          }
        : null,
    }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return a.id < b.id ? -1 : 1;
    });
}

/**
 * Dismisses a flag. Returns false when there is nothing to dismiss, so the
 * controller can answer 404 rather than pretending.
 */
export async function dismissInsight(
  prisma: PrismaClient,
  { id, userId }: { id: string; userId: string },
): Promise<boolean> {
  const { count } = await prisma.anomalyFlag.updateMany({
    where: { id, userId, dismissedAt: null },
    data: { dismissedAt: new Date() },
  });
  return count > 0;
}
