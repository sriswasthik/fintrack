/**
 * Account listing, so the upload page can offer a account selector.
 *
 * Unscoped for now — Phase 9 adds auth and restricts this to the signed-in user.
 */
import type { RequestHandler } from 'express';

import { getPrisma } from '../db';

export const listAccounts: RequestHandler = async (_req, res) => {
  const accounts = await getPrisma().account.findMany({
    select: { id: true, name: true, type: true },
    orderBy: { name: 'asc' },
  });
  res.json({ accounts });
};
