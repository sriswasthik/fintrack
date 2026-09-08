/**
 * Resolves whose data a request is about.
 *
 * Auth lands in Phase 9; until then a request carries no identity, so the scope
 * is either the owner of the account being filtered on or the single demo user.
 * Isolated here so that when Phase 9 arrives there is one place to change.
 */
import type { PrismaClient } from '../generated/prisma/client';

export async function resolveUserId(
  prisma: PrismaClient,
  accountId?: string,
): Promise<string | null> {
  if (accountId) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { userId: true },
    });
    return account?.userId ?? null;
  }

  const user = await prisma.user.findFirst({
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return user?.id ?? null;
}
