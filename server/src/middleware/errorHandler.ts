/**
 * Central error handling.
 *
 * Route handlers throw `HttpError` for anything the caller should see; anything
 * else becomes a 500 with a generic message, so an internal failure never leaks
 * a stack trace or a connection string to the client.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';

import { log } from './requestLog';
import { MAX_PDF_BYTES, MAX_UPLOAD_BYTES, UnsupportedFileTypeError } from './upload';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request body', details: error.issues });
    return;
  }

  if (error instanceof MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    // Multer's error does not carry the limit it tripped, and quoting the wrong
    // one is worse than quoting none: the PDF routes allow a larger file.
    const limit = req.path.startsWith('/statements/') ? MAX_PDF_BYTES : MAX_UPLOAD_BYTES;
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${Math.round(limit / 1024 / 1024)}MB limit`
        : error.message;
    res.status(status).json({ error: message });
    return;
  }

  if (error instanceof UnsupportedFileTypeError) {
    res.status(400).json({ error: error.message });
    return;
  }

  // The stack goes to the log under the request's ID; the caller gets the ID
  // alone, which is enough to find it and says nothing about the internals.
  log('error', 'unhandled error', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    userId: req.userId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
};
