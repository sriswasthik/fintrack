/**
 * Resolves whose data a request is about.
 *
 * There is exactly one answer: the user the access token authenticates. An
 * `accountId` in a query string narrows *within* that user's accounts and is
 * never itself a claim about identity — before Phase 9 it was, which is how a
 * request could reach another account's data by naming it.
 */
import type { Request } from 'express';

import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * The caller, having confirmed any account they named is theirs.
 *
 * An account belonging to somebody else answers 404 rather than silently
 * falling back to the caller's own data — quietly ignoring the filter would
 * return numbers that look like an answer to a question nobody asked.
 */
export async function scopeToUser(
  prisma: PrismaClient,
  req: Request,
  accountId?: string,
): Promise<string> {
  const userId = currentUserId(req);

  if (accountId) {
    const account = await prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) throw new HttpError(404, `No account with id "${accountId}"`);
  }

  return userId;
}
