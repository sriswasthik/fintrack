/**
 * The signed-in person's own account (Phase 20): changing the password, and
 * deleting the account with everything in it.
 *
 * Mounted behind the session middleware like any data route, so a demo
 * session is refused both — the shared sample account must not be deletable
 * by the visitor who happens to be looking at it.
 */
import type { CookieOptions, RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { hashPassword, verifyPassword } from '../services/auth/passwords';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../services/auth/tokens';
import { newPasswordSchema, startSession } from './auth';

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: newPasswordSchema,
});

/**
 * POST /api/me/password
 *
 * Needs the current password, even from a signed-in session: a session is
 * something that can be left open on a shared machine, and a password change
 * is how somebody would lock the owner out.
 *
 * Every other session ends — the reason people change a password is usually
 * that they think somebody else has it — and this one is re-issued, so the
 * person making the change stays signed in.
 *
 * A wrong current password is a 400, not a 401. The client treats 401 as an
 * expired session and tries a refresh, which is the wrong response to a typo.
 */
export const changePassword: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
  if (!user) throw new HttpError(401, 'Session no longer valid');

  if (!user.passwordHash) {
    throw new HttpError(
      400,
      'This account signs in with Google and has no password yet. Use "Forgot password" on the sign-in page to set one.',
    );
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new HttpError(400, 'Your current password is incorrect');
  }

  await getPrisma().$transaction([
    getPrisma().user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    }),
    getPrisma().refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  res.json(await startSession(res, user));
};

const deleteSchema = z.object({
  /** Typed out by the person, as the confirmation that they mean it. */
  email: z.string().trim().toLowerCase().min(1, 'Type your email address to confirm'),
  /** Required when the account has one. */
  password: z.string().max(200).optional(),
});

/**
 * DELETE /api/me
 *
 * Removes the user and, by cascade, every account, transaction, import, rule,
 * budget, payee, flag, summary and session they own. There is no soft delete
 * and no grace period: this is the "delete my data" a finance app owes the
 * people whose statements it holds.
 */
export const deleteMe: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { email, password } = deleteSchema.parse(req.body);

  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) throw new HttpError(401, 'Session no longer valid');

  if (email !== user.email.toLowerCase()) {
    throw new HttpError(400, 'That is not the email address on this account');
  }
  if (user.passwordHash) {
    if (!password) throw new HttpError(400, 'Enter your password to confirm');
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(400, 'Your password is incorrect');
    }
  }

  await getPrisma().user.delete({ where: { id: userId } });

  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options as CookieOptions);
  res.status(204).send();
};
