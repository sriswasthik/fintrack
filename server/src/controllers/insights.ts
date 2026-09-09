/**
 * Insights — the anomaly flags behind the dashboard panel.
 *
 * The GET recomputes the month before answering. Detection is a pure function
 * of the transactions and writes through a fingerprint, so re-running it is an
 * idempotent upsert rather than a second copy of every insight — and it is the
 * only way to guarantee the panel reflects the data as it stands rather than as
 * it stood at the last import. Dismissals are preserved across the refresh; see
 * services/anomalies/apply.ts.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { dismissInsight, listInsights, refreshAnomalies } from '../services/anomalies/apply';
import { toIsoMonth } from '../services/dashboard/window';
import { scopeToUser } from './user-scope';

const insightsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
  /**
   * Used only to work out whose insights these are. Anomalies are detected
   * across a user's accounts, because a transfer or a refund routinely spans
   * two of them, so this does not filter the results.
   */
  accountId: z.string().min(1).optional(),
});

export const getInsights: RequestHandler = async (req, res) => {
  const query = insightsQuerySchema.parse(req.query);
  const month = query.month ?? toIsoMonth(new Date());

  const prisma = getPrisma();
  const userId = await scopeToUser(prisma, req, query.accountId);

  const summary = await refreshAnomalies(prisma, { userId, month });
  const insights = await listInsights(prisma, { userId, month });

  res.json({
    month,
    insights,
    /** Detected includes flags the user has since dismissed; `insights` does not. */
    detected: summary.detected,
  });
};

export const deleteInsight: RequestHandler = async (req, res) => {
  const id = z.string().min(1).parse(req.params.id);

  const prisma = getPrisma();
  const userId = currentUserId(req);

  const dismissed = await dismissInsight(prisma, { id, userId });
  if (!dismissed) throw new HttpError(404, 'No active insight with that id');

  res.status(204).send();
};
