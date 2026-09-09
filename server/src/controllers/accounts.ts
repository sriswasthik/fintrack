/**
 * The caller's accounts.
 *
 * Creating one is part of signing up in practice: a new user has no accounts,
 * and every import has to name the account it belongs to, so without this a
 * registered user cannot do anything at all.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { ACCOUNT_TYPES } from '../services/rules/categories';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';

export const listAccounts: RequestHandler = async (req, res) => {
  const accounts = await getPrisma().account.findMany({
    where: { userId: currentUserId(req) },
    select: { id: true, name: true, type: true },
    orderBy: { name: 'asc' },
  });
  res.json({ accounts });
};

const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'An account name is required').max(120),
  type: z.enum(ACCOUNT_TYPES),
});

export const createAccount: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { name, type } = createAccountSchema.parse(req.body);

  // Names are unique per user, which is what makes "Everyday Checking"
  // available to everybody without any two people colliding.
  const existing = await getPrisma().account.findFirst({ where: { userId, name } });
  if (existing) throw new HttpError(409, `You already have an account called "${name}"`);

  const account = await getPrisma().account.create({
    data: { userId, name, type },
    select: { id: true, name: true, type: true },
  });

  res.status(201).json({ account });
};
