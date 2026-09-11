/**
 * The payee ledger endpoints.
 *
 * Both hand off to `services/payees/aggregate.ts`, which computes the totals
 * from the transactions on every request rather than reading a stored column.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { getPayee, listPayees, PAYEE_SORTS } from '../services/payees/aggregate';

const listQuerySchema = z.object({
  /** Case-insensitive substring of the name, UPI address or phone. */
  q: z.string().trim().max(200).optional(),
  sort: z.enum(PAYEE_SORTS).default('net'),
  /** Defaults per-sort below: a name reads A-Z, a total reads biggest first. */
  direction: z.enum(['asc', 'desc']).optional(),
});

/** GET /api/payees */
export const listPayeesHandler: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { q, sort, direction } = listQuerySchema.parse(req.query);

  const payees = await listPayees(getPrisma(), {
    userId,
    search: q,
    sort,
    // Ascending for a name, descending for a number: nobody wants the smallest
    // total or the oldest transaction first.
    direction: direction ?? (sort === 'name' ? 'asc' : 'desc'),
  });

  res.json({ payees, sort, direction: direction ?? (sort === 'name' ? 'asc' : 'desc') });
};

/** Express 5 types a route param as `string | string[]`; a single segment is a string. */
function idParam(req: { params: Record<string, string | string[] | undefined> }): string {
  const value = req.params.id;
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'Missing payee id');
  return value;
}

/** GET /api/payees/:id */
export const getPayeeHandler: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const payee = await getPayee(getPrisma(), { userId, payeeId: idParam(req) });

  // Somebody else's payee is a 404, not a 403: the response must not confirm
  // that the id exists (Phase 9).
  if (!payee) throw new HttpError(404, 'Payee not found');

  res.json({ payee });
};
