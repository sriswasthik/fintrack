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

import { MAX_UPLOAD_BYTES } from './upload';

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

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
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
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`
        : error.message;
    res.status(status).json({ error: message });
    return;
  }

  if (error instanceof Error && error.message === 'Only .csv files can be uploaded') {
    res.status(400).json({ error: error.message });
    return;
  }

  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
};
