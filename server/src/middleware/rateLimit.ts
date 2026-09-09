/**
 * Rate limits on the routes that cost something.
 *
 * Three of them do real work per request rather than a cheap read: an upload
 * parses a whole file, a categorization pass walks every unresolved merchant
 * and can call a model, and a summary is a model call by definition. Left open
 * they are the routes that turn one account into a bill.
 *
 * Keyed by user where there is one, so a shared office IP does not throttle
 * everybody because one person is importing statements.
 */
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

function keyBy(req: Request): string {
  // ipKeyGenerator normalizes IPv6 to a /64 prefix, so a single client cannot
  // walk through addresses to get a fresh budget.
  return req.userId ?? ipKeyGenerator(req.ip ?? '');
}

function limiter(max: number, message: string): ReturnType<typeof rateLimit> {
  const options: Partial<Options> = {
    windowMs: WINDOW_MS,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyBy,
    message: { error: message },
    // Tests and scripts drive these routes hard on purpose.
    skip: () => process.env.NODE_ENV === 'test',
  };
  return rateLimit(options);
}

/** Parsing a statement is the most expensive thing an unauthenticated-ish request can ask for. */
export const uploadLimiter = limiter(30, 'Too many uploads. Wait a few minutes and try again.');

/** A categorization pass can fan out to the model across every unknown merchant. */
export const categorizeLimiter = limiter(
  20,
  'Too many categorization runs. Wait a few minutes and try again.',
);

/** Every generated summary is a model call; a cached read is not limited. */
export const summaryLimiter = limiter(
  20,
  'Too many summary requests. Wait a few minutes and try again.',
);

/** Guessing passwords should be slow, and enumerating accounts slower. */
export const authLimiter = limiter(
  20,
  'Too many authentication attempts. Wait a few minutes and try again.',
);
