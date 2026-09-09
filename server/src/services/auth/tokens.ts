/**
 * Token minting and verification (PROJECT_CONTEXT.md §3).
 *
 * Two tokens with deliberately different jobs:
 *
 *   * The **access token** is a short-lived JWT the client holds in memory and
 *     sends as a bearer header. It is never written to storage the browser
 *     keeps, so a cross-site scripting bug cannot read a session out of
 *     localStorage after the fact.
 *   * The **refresh token** is a long-lived JWT delivered as an httpOnly
 *     cookie, which JavaScript cannot read at all. Only a hash of it is
 *     stored, and each use rotates it, so a stolen refresh token is usable at
 *     most once and its use is detectable.
 *
 * The refresh token is hashed with SHA-256 rather than bcrypt on purpose. The
 * argument for bcrypt is that human passwords are low-entropy and need to be
 * slow to guess; a 256-bit signed token is neither, and refresh runs on every
 * expired access token, so a deliberately slow hash would buy nothing and cost
 * a lot.
 */
import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

/** Short, because the client can always refresh. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Long, because this is what keeps a person signed in across days. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const REFRESH_COOKIE_NAME = 'fintrack_refresh';

/** What a verified access token tells us about the caller. */
export interface AccessTokenClaims {
  /** The user this token authenticates. */
  userId: string;
  /**
   * True for a session handed out by demo mode. Carried in the token rather
   * than looked up per request, so a read-only session cannot be widened by
   * anything that happens in the database afterwards.
   */
  demo: boolean;
}

export interface RefreshTokenPayload {
  sub: string;
  /** Identifies this particular token, so a rotation can be traced. */
  jti: string;
}

/**
 * Raised when the server cannot sign or verify tokens at all.
 *
 * Kept distinct from an invalid token: one means a visitor sent something
 * wrong, the other means the deployment is broken and every sign-in will fail
 * until someone sets an environment variable.
 */
export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

function secret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name];
  if (!value) {
    throw new AuthConfigurationError(
      `${name} is not set — copy server/.env.example to server/.env and generate one, e.g. \`openssl rand -base64 32\``,
    );
  }
  return value;
}

export function signAccessToken(
  userId: string,
  options: { demo?: boolean; expiresIn?: number } = {},
): string {
  // A jti makes every issued token distinct. Two tokens for the same user in
  // the same second would otherwise be byte-identical, which makes a refresh
  // look like it did nothing and leaves nothing to identify a token by in a
  // log or a future revocation list.
  const claims = { sub: userId, jti: randomUUID(), ...(options.demo ? { demo: true } : {}) };
  return jwt.sign(claims, secret('JWT_ACCESS_SECRET'), {
    expiresIn: options.expiresIn ?? ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** The claims in a valid access token, or null for anything else. */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const payload = jwt.verify(token, secret('JWT_ACCESS_SECRET'));
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
    // Anything other than an explicit `true` is a normal session. A token
    // cannot be forged into a demo one, but it must not be possible to fall
    // *out* of demo by sending an odd value either.
    return { userId: payload.sub, demo: payload.demo === true };
  } catch (error) {
    // A malformed or expired token is a normal thing for a client to send; a
    // missing secret is not, and must not be swallowed as "unauthorized".
    if (error instanceof AuthConfigurationError) throw error;
    return null;
  }
}

export interface IssuedRefreshToken {
  token: string;
  tokenHash: string;
  jti: string;
  expiresAt: Date;
}

export function issueRefreshToken(userId: string): IssuedRefreshToken {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, jti }, secret('JWT_REFRESH_SECRET'), {
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
  });
  return {
    token,
    tokenHash: hashToken(token),
    jti,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
  };
}

/** The payload of a validly signed, unexpired refresh token, or null. */
export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    const payload = jwt.verify(token, secret('JWT_REFRESH_SECRET'));
    if (typeof payload === 'string') return null;
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
    return { sub: payload.sub, jti: payload.jti };
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw error;
    return null;
  }
}

/** What goes in the database. Never the token itself. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Cookie options for the refresh token.
 *
 * `secure` is off in development because the Vite dev server talks to the API
 * over plain HTTP on localhost and a secure cookie would simply never be sent.
 * Everywhere else it is on.
 */
export function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: string;
  maxAge: number;
} {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    // The client and API are on different origins in development (:5173 and
    // :4000), and a lax cookie is not sent on a cross-site XHR — so the cookie
    // has to be SameSite=None, which browsers only honour when it is secure.
    sameSite: production ? 'none' : 'lax',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  };
}
