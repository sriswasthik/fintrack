/**
 * The rate limiters are skipped under NODE_ENV=test, so what can be asserted
 * here is their configuration rather than their behaviour under load — which
 * is the part that was wrong: the refresh probe every signed-out page load
 * makes was counting against the budget for signing in.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { REFRESH_COOKIE_NAME } from '../services/auth/tokens';
import { skipCookielessRefresh } from './rateLimit';

const skip = (cookies: Record<string, string>) => {
  // Under NODE_ENV=test every limiter is skipped outright, so ask the
  // predicate the question a deployed server would ask it.
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return skipCookielessRefresh({ cookies } as unknown as Request);
  } finally {
    process.env.NODE_ENV = saved;
  }
};

describe('the refresh limiter', () => {
  it('ignores a refresh that presents no cookie', () => {
    // What a signed-out browser does on every page load. It fails by design,
    // and counting it would let ordinary browsing lock an address out.
    expect(skip({})).toBe(true);
  });

  it('counts a refresh that presents a cookie and fails', () => {
    expect(skip({ [REFRESH_COOKIE_NAME]: 'a.token.value' })).toBe(false);
  });
});
