/**
 * Register, sign in, refresh, sign out.
 *
 * The shape of the session is described in services/auth/tokens.ts. What lives
 * here is the part that touches the database and the response: which token goes
 * in the body, which goes in a cookie, and what is recorded so a session can be
 * revoked.
 *
 * Two rules run through all of it. A response never says whether an email
 * address has an account — not on registration, not on a failed sign-in — and
 * a refresh token is single-use: presenting one rotates it, and presenting a
 * revoked one is treated as a compromised session rather than a retry.
 */
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { HttpError } from '../middleware/errorHandler';
import {
  burnPasswordTime,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../services/auth/passwords';
import { DEMO_SESSION_TTL_SECONDS, demoModeEnabled, demoUserEmail } from '../services/auth/demo';
import { consumePasswordReset, createPasswordReset } from '../services/auth/passwordReset';
import { sendPasswordResetEmail } from '../services/email/passwordReset';
import { emailConfigured } from '../services/email/send';
import { sendWelcomeEmail } from '../services/email/welcome';
import {
  InvalidGoogleTokenError,
  resolveGoogleUser,
  verifyGoogleIdToken,
} from '../services/auth/google';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashToken,
  issueRefreshToken,
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
  signAccessToken,
  verifyRefreshToken,
} from '../services/auth/tokens';

const emailSchema = z.string().trim().toLowerCase().email('A valid email address is required');

export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200);

const credentialsSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
});

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
});

interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/** Everything a signed-in client needs, and nothing it does not. */
function sessionBody(user: SessionUser, accessToken: string, options: { demo?: boolean } = {}) {
  const demo = options.demo === true;
  return {
    accessToken,
    expiresIn: demo ? DEMO_SESSION_TTL_SECONDS : ACCESS_TOKEN_TTL_SECONDS,
    user: { id: user.id, email: user.email, name: user.name },
    // The client renders a read-only banner and hides its write controls from
    // this, and knows to renew a demo session by asking for a new one rather
    // than by presenting a refresh cookie it was never given.
    demo,
  };
}

/** Issues a refresh cookie and returns the session body. Shared with the account routes. */
export async function startSession(res: Response, user: SessionUser) {
  const refresh = issueRefreshToken(user.id);

  await getPrisma().refreshToken.create({
    data: { userId: user.id, tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt },
  });

  res.cookie(REFRESH_COOKIE_NAME, refresh.token, refreshCookieOptions() as CookieOptions);
  return sessionBody(user, signAccessToken(user.id));
}

export const register: RequestHandler = async (req, res) => {
  const { email, password, name } = registerSchema.parse(req.body);

  const existing = await getPrisma().user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    // Deliberately the same 409 wording a caller would get for any conflict:
    // enough to act on, not enough to enumerate who has an account.
    throw new HttpError(409, 'That email address cannot be registered');
  }

  const user = await getPrisma().user.create({
    data: { email, name: name ?? null, passwordHash: await hashPassword(password) },
    select: { id: true, email: true, name: true },
  });

  res.status(201).json(await startSession(res, user));

  // After the response, and deliberately not awaited: a slow or broken mail
  // provider must not hold a registration open or turn a created account into
  // a 500. `sendWelcomeEmail` cannot throw and cannot reject (Phase 17).
  sendWelcomeEmail(user);
};

export const login: RequestHandler = async (req, res) => {
  const { email, password } = credentialsSchema.parse(req.body);

  const user = await getPrisma().user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  // A Google-only account (Phase 16) has no hash to compare against. It is
  // handled here beside the missing-account case, and answers identically:
  // the same 401, after the same bcrypt-shaped delay. Anything else would turn
  // this endpoint into an oracle for which addresses signed up with Google.
  if (!user?.passwordHash) {
    // Spend the time bcrypt would have spent, so a missing account and a wrong
    // password are not distinguishable by how long the answer takes.
    await burnPasswordTime(password);
    throw new HttpError(401, 'Incorrect email or password');
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(401, 'Incorrect email or password');
  }

  res.json(await startSession(res, user));
};

const googleSchema = z.object({
  /** The ID token Google handed the browser. Never trusted until verified. */
  credential: z.string().min(1, 'A Google credential is required').max(8192),
});

/**
 * POST /api/auth/google
 *
 * Verifies the ID token, finds or creates the account behind it, and starts
 * exactly the session `login` and `register` start: the same 15-minute access
 * token in the body, the same rotating httpOnly refresh cookie. That sameness
 * is the design — every protected route, the refresh rotation and the demo
 * guard all carry on working without knowing this endpoint exists.
 *
 * The response carries `isNewUser` so Phase 17 can decide whether to send a
 * welcome email. `resolution` says which of the three paths ran, which is
 * useful in a log and harmless to the caller: it tells them only about their
 * own account.
 */
export const googleSignIn: RequestHandler = async (req, res) => {
  const { credential } = googleSchema.parse(req.body);

  let identity;
  try {
    identity = await verifyGoogleIdToken(credential);
  } catch (error) {
    // A visitor sending a bad token is a 401. A deployment with no
    // GOOGLE_CLIENT_ID is not — that is `AuthConfigurationError`, which is left
    // to rise to the handler that turns it into a 500 saying what to set.
    if (error instanceof InvalidGoogleTokenError) throw new HttpError(401, error.message);
    throw error;
  }

  const { user, resolution, isNewUser } = await resolveGoogleUser(getPrisma(), identity);
  const session = await startSession(res, user);

  // 201 when this request created the account, 200 when it signed in or linked
  // an account that already existed — the same distinction `register` and
  // `login` already draw.
  res.status(isNewUser ? 201 : 200).json({ ...session, isNewUser, resolution });

  // Only a genuinely new account is welcomed. Linking Google to an account that
  // already existed, and every repeat sign-in, are not first-ever signups — and
  // `isNewUser` is the flag Phase 16 added to say which is which.
  if (isNewUser) sendWelcomeEmail(user);
};

/** The refresh token on the request, from the cookie or the body. */
function presentedRefreshToken(req: Request): string | null {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  // A non-browser client (a script, a mobile app) has no cookie jar.
  const body = req.body as { refreshToken?: unknown } | undefined;
  return typeof body?.refreshToken === 'string' ? body.refreshToken : null;
}

export const refresh: RequestHandler = async (req, res) => {
  const token = presentedRefreshToken(req);
  if (!token) throw new HttpError(401, 'No refresh token');

  const payload = verifyRefreshToken(token);
  if (!payload) throw new HttpError(401, 'Invalid or expired refresh token');

  const stored = await getPrisma().refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true },
  });

  if (!stored || stored.userId !== payload.sub) {
    throw new HttpError(401, 'Invalid or expired refresh token');
  }

  if (stored.revokedAt || stored.expiresAt <= new Date()) {
    // A token that was already spent should never come back. Either it was
    // replayed or it was stolen, and there is no way to tell which — so every
    // session for this user ends and they sign in again.
    await getPrisma().refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new HttpError(401, 'Refresh token has already been used');
  }

  const user = await getPrisma().user.findUnique({
    where: { id: stored.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new HttpError(401, 'Invalid or expired refresh token');

  // Rotate: the presented token dies as the new one is created, in one
  // transaction, so a crash between the two cannot leave a session with no
  // valid token or with two.
  const next = issueRefreshToken(user.id);
  await getPrisma().$transaction([
    getPrisma().refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    }),
    getPrisma().refreshToken.create({
      data: { userId: user.id, tokenHash: next.tokenHash, expiresAt: next.expiresAt },
    }),
  ]);

  res.cookie(REFRESH_COOKIE_NAME, next.token, refreshCookieOptions() as CookieOptions);
  res.json(sessionBody(user, signAccessToken(user.id)));
};

export const logout: RequestHandler = async (req, res) => {
  const token = presentedRefreshToken(req);

  if (token) {
    await getPrisma().refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options as CookieOptions);
  // Signing out is idempotent: no token, or one already revoked, is still a
  // signed-out client, and saying otherwise only leaks state.
  res.status(204).send();
};

/** Who the bearer token belongs to, for the client to restore a session. */
export const me: RequestHandler = async (req, res) => {
  const user = await getPrisma().user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      picture: true,
      passwordHash: true,
      googleId: true,
    },
  });
  if (!user) throw new HttpError(401, 'Session no longer valid');
  const { passwordHash, googleId, ...profile } = user;
  // Whether each way in exists — never the values. The settings page needs to
  // know whether "change password" can ask for the current one.
  res.json({
    user: { ...profile, hasPassword: passwordHash !== null, hasGoogle: googleId !== null },
  });
};

const RESET_ACCEPTED =
  'If that address has an account, a link to reset its password is on its way. It works for an hour.';

/**
 * POST /api/auth/forgot-password
 *
 * Always the same 202 and the same words, whether or not the address has an
 * account — this endpoint must not become a way to ask which addresses do.
 * The email goes in the background for the same reason (see
 * `sendPasswordResetEmail`). A Google-only account is sent a link too: that
 * is how somebody who signed up with Google gives themselves a password.
 */
export const forgotPassword: RequestHandler = async (req, res) => {
  const { email } = z.object({ email: emailSchema }).parse(req.body);

  // With no mail provider, "a link is on its way" would be a promise nothing
  // keeps, and the person would wait for an email that never comes. Saying so
  // is the same answer for every address, so it tells nobody which ones have
  // an account. Outside production the link goes to the console instead (see
  // `sendPasswordResetEmail`), so the flow can still be tried locally.
  if (!emailConfigured() && process.env.NODE_ENV === 'production') {
    throw new HttpError(
      503,
      'Password reset by email is not available on this server yet. Sign in another way, or ask whoever runs it.',
    );
  }

  const user = await getPrisma().user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });

  // The shared demo account is never resettable: whoever held a link to it
  // would own what every visitor sees.
  if (user && user.email !== demoUserEmail()) {
    const token = await createPasswordReset(getPrisma(), user.id);
    sendPasswordResetEmail(user, token);
  }

  res.status(202).json({ message: RESET_ACCEPTED });
};

const resetSchema = z.object({
  token: z.string().min(1, 'The reset link is missing its token').max(200),
  password: newPasswordSchema,
});

/**
 * POST /api/auth/reset-password
 *
 * Spends the link, sets the password, and ends every existing session: a
 * reset is often somebody taking an account back, and a session the other
 * party still holds should not survive it. The person then signs in fresh.
 */
export const resetPassword: RequestHandler = async (req, res) => {
  const { token, password } = resetSchema.parse(req.body);

  const userId = await consumePasswordReset(getPrisma(), token);
  if (!userId) {
    throw new HttpError(400, 'This reset link is invalid, already used, or has expired');
  }

  const passwordHash = await hashPassword(password);
  await getPrisma().$transaction([
    getPrisma().user.update({ where: { id: userId }, data: { passwordHash } }),
    getPrisma().refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  res.json({ message: 'Your password has been changed. Sign in with the new one.' });
};

/**
 * POST /api/auth/demo — a read-only session on the shared sample account.
 *
 * No password, and deliberately no refresh cookie: this session is meant to
 * expire and be re-requested, not to persist in somebody's browser. What it
 * can do is bounded by `requireWritableSession`, not by what it is given here.
 */
export const demoSession: RequestHandler = async (_req, res) => {
  if (!demoModeEnabled()) {
    throw new HttpError(404, 'Demo mode is not enabled on this server');
  }

  const user = await getPrisma().user.findUnique({
    where: { email: demoUserEmail() },
    select: { id: true, email: true, name: true },
  });

  if (!user) {
    // The deployment asked for demo mode but never loaded the data. Saying so
    // is more useful than a 404 that looks like the feature does not exist.
    throw new HttpError(503, 'The demo dataset has not been seeded on this server');
  }

  res.json(
    sessionBody(
      user,
      signAccessToken(user.id, { demo: true, expiresIn: DEMO_SESSION_TTL_SECONDS }),
      {
        demo: true,
      },
    ),
  );
};
