/**
 * What has to happen after a user's transactions are removed in bulk — an
 * import undone, or a whole bank account deleted (Phase 20).
 *
 * Deleting the rows is the easy part; the cascade does it. What the cascade
 * cannot do is re-derive the things computed *across* rows:
 *
 *   * **Transfer pairs and refund links.** The surviving leg of a transfer
 *     whose other leg went is still categorized TRANSFER, and so still missing
 *     from spend. Re-running the deterministic pass re-pairs what can be paired
 *     and lets the orphan be categorized on its own merits. MANUAL rows are
 *     left alone by that pass, as they always are.
 *   * **Payees.** A payee whose every transaction has gone would sit in the
 *     ledger with zero paid and zero received, looking like a real entry.
 *
 * Anomaly flags need nothing here: a month's flags are reconciled with a fresh
 * detection every time they are read (`refreshAnomalies`).
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { resolvePayees } from '../payees/resolve';
import { applyRuleEngine } from '../rules/apply';

export interface ReconcileSummary {
  /** Payees removed because nothing pointed at them any more. */
  payeesRemoved: number;
}

export async function reconcileAfterRemoval(
  prisma: PrismaClient,
  userId: string,
): Promise<ReconcileSummary> {
  await applyRuleEngine(prisma, { userId });
  await resolvePayees(prisma, { userId });

  const { count } = await prisma.payee.deleteMany({
    where: { userId, transactions: { none: {} } },
  });

  return { payeesRemoved: count };
}
