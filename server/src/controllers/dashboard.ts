/**
 * Dashboard endpoint.
 *
 * Resolves the requested window and its comparison period, then hands off to the
 * single aggregation query in services/dashboard/aggregate.ts.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { HttpError } from '../middleware/errorHandler';
import { aggregateDashboard, type Granularity } from '../services/dashboard/aggregate';
import {
  addDays,
  comparisonWindow,
  monthWindow,
  rangeWindow,
  toIsoDate,
  toIsoMonth,
} from '../services/dashboard/window';
import { CATEGORIES } from '../services/rules/categories';

const dashboardQuerySchema = z
  .object({
    /** YYYY-MM. Ignored when an explicit from/to range is given. */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
      .optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    accountId: z.string().min(1).optional(),
    /** Repeatable, or a single comma-separated value. */
    categories: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) => {
        if (!value) return undefined;
        const list = (Array.isArray(value) ? value : value.split(','))
          .map((v) => v.trim())
          .filter(Boolean);
        return list.length > 0 ? list : undefined;
      })
      .pipe(z.array(z.enum(CATEGORIES)).optional()),
    granularity: z.enum(['daily', 'weekly']).default('daily'),
  })
  .refine((value) => !(value.from && !value.to) && !(value.to && !value.from), {
    message: 'from and to must be supplied together',
  });

export const getDashboard: RequestHandler = async (req, res) => {
  const query = dashboardQuerySchema.parse(req.query);

  const isCustomRange = Boolean(query.from && query.to);
  const month = isCustomRange ? undefined : (query.month ?? toIsoMonth(new Date()));

  const window = isCustomRange ? rangeWindow(query.from!, query.to!) : monthWindow(month!);
  if (window.to <= window.from) throw new HttpError(400, 'to must not be before from');

  const previous = comparisonWindow(window, month);

  // Without a user in the request (auth arrives in Phase 9) the dashboard is
  // scoped to whichever account was asked for, or to the single demo user.
  const userId = query.accountId
    ? (
        await getPrisma().account.findUnique({
          where: { id: query.accountId },
          select: { userId: true },
        })
      )?.userId
    : (await getPrisma().user.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }))
        ?.id;

  if (!userId) throw new HttpError(404, 'No account or user to build a dashboard for');

  const result = await aggregateDashboard(getPrisma(), {
    userId,
    from: window.from,
    to: window.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    accountId: query.accountId,
    categories: query.categories,
    granularity: query.granularity as Granularity,
  });

  res.json({
    range: {
      from: toIsoDate(window.from),
      to: toIsoDate(addDays(window.to, -1)),
      month: month ?? null,
      granularity: query.granularity,
    },
    previousRange: {
      from: toIsoDate(previous.from),
      to: toIsoDate(addDays(previous.to, -1)),
    },
    filters: { accountId: query.accountId ?? null, categories: query.categories ?? null },
    ...result,
  });
};
