/**
 * Import history, and undoing an import (Phase 20).
 *
 * Every Confirm Import writes one `ImportBatch` and tags its rows with it, so
 * a statement committed to the wrong account, or twice, or for the wrong month
 * can be taken back out as the unit it went in as.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { reconcileAfterRemoval } from '../services/imports/reconcile';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** GET /api/imports — newest first. */
export const listImports: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { limit } = listQuerySchema.parse(req.query);

  const batches = await getPrisma().importBatch.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: {
      id: true,
      fileNames: true,
      rowCount: true,
      createdAt: true,
      account: { select: { id: true, name: true } },
    },
  });

  // The date span each import covers, in one grouped query rather than one per
  // row. Worth showing: "Mar 1 – Mar 31" is how a person recognises which
  // statement an import was.
  const spans = batches.length
    ? await getPrisma().transaction.groupBy({
        by: ['importBatchId'],
        where: { importBatchId: { in: batches.map((b) => b.id) } },
        _min: { date: true },
        _max: { date: true },
        _count: { _all: true },
      })
    : [];
  const spanOf = new Map(spans.map((s) => [s.importBatchId, s]));

  res.json({
    imports: batches.map((batch) => {
      const span = spanOf.get(batch.id);
      return {
        id: batch.id,
        account: batch.account,
        fileNames: batch.fileNames,
        rowCount: batch.rowCount,
        /** Rows still present. Lower than rowCount once any have been deleted. */
        remaining: span?._count._all ?? 0,
        from: span?._min.date ? span._min.date.toISOString().slice(0, 10) : null,
        to: span?._max.date ? span._max.date.toISOString().slice(0, 10) : null,
        createdAt: batch.createdAt.toISOString(),
      };
    }),
  });
};

/**
 * DELETE /api/imports/:id
 *
 * Removes every row the import brought in — including ones a person has since
 * recategorized, because undoing an import means the statement was never
 * imported, and a correction to a row that should not exist is not worth
 * keeping. A learned rule the correction taught is kept: it is about the
 * merchant, not the row, and still true.
 */
export const undoImport: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const id = z.string().min(1).parse(req.params.id);

  const batch = await getPrisma().importBatch.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!batch) throw new HttpError(404, 'No such import');

  const removedTransactions = await getPrisma().transaction.count({
    where: { importBatchId: batch.id },
  });
  // The batch's rows go with it (onDelete: Cascade on Transaction.importBatch).
  await getPrisma().importBatch.delete({ where: { id: batch.id } });
  const { payeesRemoved } = await reconcileAfterRemoval(getPrisma(), userId);

  res.json({ removedTransactions, payeesRemoved });
};
