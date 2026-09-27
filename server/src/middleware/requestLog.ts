/**
 * A request ID on every request, and one log line per request.
 *
 * When someone reports "the import failed", the question is which request, and
 * what happened in it. The ID answers the first: it is sent back in a header,
 * and in the body of any 500, so the person can quote it. The log line answers
 * the second: method, path, status, time taken, and whose request it was.
 *
 * What is deliberately never logged: query strings and request bodies. On this
 * API they carry amounts, merchants and statement text, and a log pipeline is
 * a place data ends up without anyone deciding it should.
 */
import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set on every request by `requestContext`. */
      requestId?: string;
    }
  }
}

type Level = 'info' | 'warn' | 'error';

/**
 * One structured line. JSON in production, where the platform's log search
 * can filter on fields; a readable line locally.
 */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const write =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : (line: string) => process.stdout.write(`${line}\n`);
  if (process.env.NODE_ENV === 'production') {
    write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
    return;
  }
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  write(`[${level}] ${message}${detail ? ` ${detail}` : ''}`);
}

/**
 * An ID the platform already assigned is reused, so its request logs and ours
 * line up; anything else a caller sends is ignored rather than trusted, since
 * it ends up in our logs.
 */
const INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && INCOMING_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  // Tests drive thousands of requests; their output is the assertions.
  if (process.env.NODE_ENV === 'test') {
    next();
    return;
  }

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    // The platform's health check runs every few seconds; a passing one is noise.
    if (path === '/api/health' && res.statusCode < 400) return;

    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'request', {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      userId: req.userId,
    });
  });
  next();
};
