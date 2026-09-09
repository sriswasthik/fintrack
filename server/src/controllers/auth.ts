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
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashToken,
  issueRefreshToken,
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
  signAccessToken,
  verifyRefreshToken,
} from '../services/auth/tokens';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email address is required'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(200),
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

async function startSession(res: Response, user: SessionUser) {
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
};

export const login: RequestHandler = async (req, res) => {
  const { email, password } = credentialsSchema.parse(req.body);

  const user = await getPrisma().user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  if (!user) {
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
    select: { id: true, email: true, name: true, createdAt: true },
  });
  if (!user) throw new HttpError(401, 'Session no longer valid');
  res.json({ user });
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
