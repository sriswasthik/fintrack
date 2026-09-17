/**
 * Range totals endpoint.
 *
 * Resolves the requested window, then hands off to the single aggregation query
 * in services/totals/aggregate.ts.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { HttpError } from '../middleware/errorHandler';
import { aggregateTotals } from '../services/totals/aggregate';
import { InvalidRangeError, RANGE_KINDS, resolveRange } from '../services/totals/range';
import { scopeToUser } from './user-scope';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const totalsQuerySchema = z.object({
  range: z.enum(RANGE_KINDS),
  date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD').optional(),
  month: z.string().regex(ISO_MONTH, 'month must be YYYY-MM').optional(),
  startDate: z.string().regex(ISO_DATE, 'startDate must be YYYY-MM-DD').optional(),
  endDate: z.string().regex(ISO_DATE, 'endDate must be YYYY-MM-DD').optional(),
  accountId: z.string().min(1).optional(),
});

export const getTotals: RequestHandler = async (req, res) => {
  const query = totalsQuerySchema.parse(req.query);

  let range;
  try {
    range = resolveRange(query);
  } catch (error) {
    // Which field is missing depends on which range was asked for, so this is a
    // 400 the resolver is better placed to word than the schema is.
    if (error instanceof InvalidRangeError) throw new HttpError(400, error.message);
    throw error;
  }

  const userId = await scopeToUser(getPrisma(), req, query.accountId);

  const totals = await aggregateTotals(getPrisma(), {
    userId,
    from: range.from,
    to: range.to,
    accountId: query.accountId,
  });

  res.json({
    range: {
      kind: range.kind,
      startDate: range.startDate,
      endDate: range.endDate,
      month: range.month,
    },
    filters: { accountId: query.accountId ?? null },
    ...totals,
  });
};
