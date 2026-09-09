import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  AuthConfigurationError,
  hashToken,
  issueRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshCookieOptions,
  signAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './tokens';

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()) as Record<string, unknown>;

describe('access tokens', () => {
  it('round-trips the user it was signed for', () => {
    expect(verifyAccessToken(signAccessToken('user_1'))).toBe('user_1');
  });

  it('is short-lived, so a leaked one stops working quickly', () => {
    const payload = decode(signAccessToken('user_1'));
    expect((payload.exp as number) - (payload.iat as number)).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it('is distinct every time, even within the same second', () => {
    expect(signAccessToken('user_1')).not.toBe(signAccessToken('user_1'));
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken('user_1');
    expect(verifyAccessToken(token.slice(0, -1) + 'x')).toBeNull();
  });

  it('rejects a token signed with the wrong secret', () => {
    const original = process.env.JWT_ACCESS_SECRET;
    const token = signAccessToken('user_1');
    process.env.JWT_ACCESS_SECRET = 'a-different-secret-entirely';
    try {
      expect(verifyAccessToken(token)).toBeNull();
    } finally {
      process.env.JWT_ACCESS_SECRET = original;
    }
  });

  it('rejects a refresh token presented as an access token', () => {
    // Different secrets, so the two are not interchangeable even though both
    // carry a `sub`.
    expect(verifyAccessToken(issueRefreshToken('user_1').token)).toBeNull();
  });

  it('rejects nonsense without throwing', () => {
    expect(verifyAccessToken('')).toBeNull();
    expect(verifyAccessToken('not.a.jwt')).toBeNull();
  });

  it('carries no personal data beyond the user id', () => {
    const payload = decode(signAccessToken('user_1'));
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sub']);
  });
});

describe('refresh tokens', () => {
  it('is long-lived and identifies itself', () => {
    const issued = issueRefreshToken('user_1');
    const payload = verifyRefreshToken(issued.token);

    expect(payload).toEqual({ sub: 'user_1', jti: issued.jti });
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(REFRESH_TOKEN_TTL_SECONDS).toBeGreaterThan(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('stores a hash, never the token', () => {
    const issued = issueRefreshToken('user_1');
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically, so a presented token can be looked up', () => {
    const token = issueRefreshToken('user_1').token;
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('rejects an access token presented as a refresh token', () => {
    expect(verifyRefreshToken(signAccessToken('user_1'))).toBeNull();
  });

  it('is a different token every time, even for the same user', () => {
    expect(issueRefreshToken('user_1').token).not.toBe(issueRefreshToken('user_1').token);
  });
});

describe('the refresh cookie', () => {
  it('is unreadable by JavaScript and scoped to the auth routes', () => {
    const options = refreshCookieOptions();
    expect(options.httpOnly).toBe(true);
    // Nothing outside /api/auth ever needs it, so nothing else receives it.
    expect(options.path).toBe('/api/auth');
    expect(options.maxAge).toBe(REFRESH_TOKEN_TTL_SECONDS * 1000);
  });

  it('is secure and cross-site in production, plain and lax in development', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(refreshCookieOptions()).toMatchObject({ secure: true, sameSite: 'none' });
      process.env.NODE_ENV = 'development';
      // A secure cookie would simply never be sent over plain-HTTP localhost.
      expect(refreshCookieOptions()).toMatchObject({ secure: false, sameSite: 'lax' });
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('when the signing secrets are missing', () => {
  it('says so instead of failing as though the token were invalid', () => {
    const original = process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_ACCESS_SECRET;
    try {
      expect(() => signAccessToken('user_1')).toThrow(AuthConfigurationError);
      expect(() => verifyAccessToken('anything')).toThrow(AuthConfigurationError);
    } finally {
      process.env.JWT_ACCESS_SECRET = original;
    }
  });
});
