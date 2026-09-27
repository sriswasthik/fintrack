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
import { reconcileAfterRemoval } from '../services/imports/reconcile';
import { ACCOUNT_TYPES } from '../services/rules/categories';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';

export const listAccounts: RequestHandler = async (req, res) => {
  const accounts = await getPrisma().account.findMany({
    where: { userId: currentUserId(req) },
    select: { id: true, name: true, type: true, _count: { select: { transactions: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({
    accounts: accounts.map(({ _count, ...account }) => ({
      ...account,
      // What deleting the account would take with it, so the client can say so.
      transactionCount: _count.transactions,
    })),
  });
};

const accountName = z.string().trim().min(1, 'An account name is required').max(120);

const createAccountSchema = z.object({
  name: accountName,
  type: z.enum(ACCOUNT_TYPES),
});

const updateAccountSchema = z
  .object({ name: accountName.optional(), type: z.enum(ACCOUNT_TYPES).optional() })
  .refine((body) => body.name !== undefined || body.type !== undefined, {
    message: 'Nothing to change: give a name or a type',
  });

const nameTaken = (name: string) =>
  new HttpError(409, `You already have an account called "${name}"`);

export const createAccount: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { name, type } = createAccountSchema.parse(req.body);

  // Names are unique per user, which is what makes "Everyday Checking"
  // available to everybody without any two people colliding.
  const existing = await getPrisma().account.findFirst({ where: { userId, name } });
  if (existing) throw nameTaken(name);

  const account = await getPrisma().account.create({
    data: { userId, name, type },
    select: { id: true, name: true, type: true },
  });

  res.status(201).json({ account: { ...account, transactionCount: 0 } });
};

/** Express 5 types a route param as `string | string[]`. */
function idParam(req: { params: Record<string, string | string[] | undefined> }): string {
  const value = req.params.id;
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'Missing account id');
  return value;
}

/**
 * The account, if it is the caller's. Somebody else's answers 404 exactly as a
 * missing one does, so an id cannot be probed for existence.
 */
async function ownedAccount(userId: string, id: string) {
  const account = await getPrisma().account.findFirst({
    where: { id, userId },
    select: { id: true, name: true, type: true },
  });
  if (!account) throw new HttpError(404, `No account with id "${id}"`);
  return account;
}

/** PATCH /api/accounts/:id — rename, or change the type. */
export const updateAccount: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const id = idParam(req);
  const changes = updateAccountSchema.parse(req.body);
  const account = await ownedAccount(userId, id);

  if (changes.name && changes.name !== account.name) {
    const clash = await getPrisma().account.findFirst({
      where: { userId, name: changes.name, NOT: { id } },
      select: { id: true },
    });
    if (clash) throw nameTaken(changes.name);
  }

  const updated = await getPrisma().account.update({
    where: { id },
    data: changes,
    select: { id: true, name: true, type: true, _count: { select: { transactions: true } } },
  });
  const { _count, ...rest } = updated;
  res.json({ account: { ...rest, transactionCount: _count.transactions } });
};

/**
 * DELETE /api/accounts/:id
 *
 * Removes the account and, by cascade, every transaction on it and every
 * import into it. Then the cross-row state is rebuilt: a transfer whose other
 * leg lived on this account is no longer a transfer, and a payee known only
 * from this account's rows has nothing left to total.
 */
export const deleteAccount: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const id = idParam(req);
  await ownedAccount(userId, id);

  const removedTransactions = await getPrisma().transaction.count({ where: { accountId: id } });
  await getPrisma().account.delete({ where: { id } });
  const { payeesRemoved } = await reconcileAfterRemoval(getPrisma(), userId);

  res.json({ removedTransactions, payeesRemoved });
};
