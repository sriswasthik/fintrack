import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { signAccessToken } from '../services/auth/tokens';
import { bearerToken, currentUserId, requireAuth } from './auth';
import { HttpError } from './errorHandler';

const asRequest = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

/** Runs the middleware and reports what happened. */
function run(req: Request): { userId?: string; error?: unknown } {
  let called = false;
  try {
    requireAuth(req, {} as never, () => {
      called = true;
    });
  } catch (error) {
    return { error };
  }
  return called ? { userId: req.userId } : { error: new Error('next() was not called') };
}

describe('bearerToken', () => {
  it('reads a bearer token however the scheme is cased', () => {
    expect(bearerToken(asRequest({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(bearerToken(asRequest({ authorization: 'bearer abc' }))).toBe('abc');
  });

  it('ignores another scheme', () => {
    expect(bearerToken(asRequest({ authorization: 'Basic abc' }))).toBeNull();
  });

  it('ignores a header with no token', () => {
    expect(bearerToken(asRequest({ authorization: 'Bearer' }))).toBeNull();
    expect(bearerToken(asRequest({ authorization: 'Bearer   ' }))).toBeNull();
    expect(bearerToken(asRequest({}))).toBeNull();
  });
});

describe('requireAuth', () => {
  it('attaches the user from a valid token', () => {
    const req = asRequest({ authorization: `Bearer ${signAccessToken('user_1')}` });
    expect(run(req)).toEqual({ userId: 'user_1' });
  });

  it('refuses a request with no token', () => {
    const { error } = run(asRequest({}));
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
  });

  it('refuses a tampered token', () => {
    const token = signAccessToken('user_1');
    const { error } = run(asRequest({ authorization: `Bearer ${token.slice(0, -1)}x` }));
    expect((error as HttpError).status).toBe(401);
  });

  it('never trusts a user id from anywhere but the token', () => {
    // A body or query parameter naming a user is a filter at most. If the
    // middleware could be talked into an identity, every ownership check
    // downstream would be built on sand.
    const req = {
      headers: { authorization: `Bearer ${signAccessToken('user_1')}` },
      body: { userId: 'user_2' },
      query: { userId: 'user_2' },
      userId: 'user_2',
    } as unknown as Request;

    expect(run(req).userId).toBe('user_1');
  });
});

describe('currentUserId', () => {
  it('returns the authenticated user', () => {
    expect(currentUserId({ userId: 'user_1' } as Request)).toBe('user_1');
  });

  it('fails loudly on a route that was never put behind requireAuth', () => {
    // A 500 on the first request beats quietly serving somebody else's data.
    expect(() => currentUserId({} as Request)).toThrow(HttpError);
    try {
      currentUserId({} as Request);
    } catch (error) {
      expect((error as HttpError).status).toBe(500);
    }
  });
});
