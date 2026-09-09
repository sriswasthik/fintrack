/**
 * Authentication middleware.
 *
 * Every data route sits behind `requireAuth`, which turns a bearer token into
 * `req.userId` or refuses the request. Nothing downstream reads an identity
 * from anywhere else — a user id in a query string or body is a filter, never
 * a claim about who is asking.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AuthConfigurationError, verifyAccessToken } from '../services/auth/tokens';
import { HttpError } from './errorHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. Present on every protected route, absent elsewhere. */
      userId?: string;
    }
  }
}

/** The bearer token on a request, if it carries one. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

export const requireAuth: RequestHandler = (req, _res, next: NextFunction) => {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'Authentication required');

  const userId = verifyAccessToken(token);
  if (!userId) throw new HttpError(401, 'Invalid or expired access token');

  req.userId = userId;
  next();
};

/**
 * The authenticated user, for a handler that has already passed `requireAuth`.
 *
 * Throwing rather than returning undefined means a route accidentally mounted
 * without the middleware fails loudly on the first request instead of quietly
 * serving somebody else's data.
 */
export function currentUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(500, 'Route is not behind requireAuth');
  }
  return req.userId;
}

/** Turns a missing signing secret into a 500 that says what to do about it. */
export function authConfigurationHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof AuthConfigurationError) {
    console.error(error.message);
    res.status(500).json({ error: 'Authentication is not configured on this server' });
    return;
  }
  next(error);
}
