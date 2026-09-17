/**
 * The Phase 19 India insights endpoint.
 *
 * One read, five statistics-only detectors, no model call and nothing written.
 * Every figure is derived on the way out rather than stored, for the same
 * reason the payee ledger is (Phase 15): a stored total is a second copy of a
 * fact, and the moment a transaction is recategorized or re-imported the copy
 * is wrong with nothing to say so.
 *
 * The lookback is twelve months because the EMI and SIP detectors want a year
 * of history to work with; the detectors narrow it themselves from there.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { toIsoDate, toIsoMonth } from '../services/dashboard/window';
import { buildIndiaInsights } from '../services/india';
import type { IndiaTransaction } from '../services/india/types';
import { scopeToUser } from './user-scope';

/** Months of history loaded. The longest any detector asks for. */
const LOOKBACK_MONTHS = 12;

const indiaQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
  /**
   * Only used to work out whose data this is. These figures are a picture of a
   * person's whole financial life — a salary paid into one account funds an EMI
   * debited from another — so they are never filtered to a single account.
   */
  accountId: z.string().min(1).optional(),
});

export const getIndiaInsights: RequestHandler = async (req, res) => {
  const query = indiaQuerySchema.parse(req.query);
  const month = query.month ?? toIsoMonth(new Date());

  const prisma = getPrisma();
  const userId = await scopeToUser(prisma, req, query.accountId);

  const [year, index] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, index - 1 - (LOOKBACK_MONTHS - 1), 1));
  const to = new Date(Date.UTC(year, index, 1));

  const rows = await prisma.transaction.findMany({
    where: { account: { userId }, date: { gte: from, lt: to } },
    select: {
      id: true,
      date: true,
      amount: true,
      category: true,
      normalizedMerchant: true,
      description: true,
    },
    orderBy: { date: 'asc' },
  });

  const transactions: IndiaTransaction[] = rows.map((row) => ({
    id: row.id,
    date: toIsoDate(row.date),
    amount: Number(row.amount),
    category: row.category,
    normalizedMerchant: row.normalizedMerchant,
    description: row.description,
  }));

  res.json(buildIndiaInsights(transactions, { month }));
};
