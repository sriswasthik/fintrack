/**
 * Password reset links (Phase 20).
 *
 * A reset token is a random secret emailed to the address on the account. It
 * is stored only as a SHA-256 hash — the same treatment as a refresh token —
 * so the table leaking is not the same as every open link leaking. It is
 * single-use, short-lived, and asking for a new one retires any older one, so
 * at most one link per account is ever live.
 */
import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '../../generated/prisma/client';
import { hashToken } from './tokens';

/** Long enough to reach an inbox and be clicked; short enough to be useless in an old one. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/** Issues a fresh link for the user, retiring any they already had. Returns the raw token. */
export async function createPasswordReset(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  // 32 random bytes: not guessable, and URL-safe as base64url.
  const token = randomBytes(32).toString('base64url');

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000),
      },
    }),
  ]);

  return token;
}

/**
 * Spends a token, returning whose it was — or null when it is unknown, used
 * or expired, which a caller must not distinguish between.
 *
 * Spent with a conditional update rather than read-then-write, so two requests
 * racing with the same link cannot both succeed.
 */
export async function consumePasswordReset(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<string | null> {
  const tokenHash = hashToken(token);

  const { count } = await prisma.passwordResetToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (count !== 1) return null;

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true },
  });
  return row?.userId ?? null;
}
