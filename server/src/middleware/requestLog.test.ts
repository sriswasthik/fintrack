import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from './errorHandler';
import { log, requestContext } from './requestLog';

/** A bare app with the two pieces under test, and one route that fails. */
function testApp() {
  const app = express();
  app.use(requestContext);
  app.get('/api/ok', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/api/boom', () => {
    throw new Error('connection refused: postgres://secret@db');
  });
  app.use(errorHandler);
  return app;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  process.env.NODE_ENV = 'test';
});

describe('requestContext', () => {
  it('gives every request an ID and returns it', async () => {
    const response = await request(testApp()).get('/api/ok').expect(200);
    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('reuses an ID the platform already assigned', async () => {
    const response = await request(testApp())
      .get('/api/ok')
      .set('X-Request-Id', 'rndr-4f2a9c81d0')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('rndr-4f2a9c81d0');
  });

  it('ignores an incoming ID it would not want in its logs', async () => {
    const response = await request(testApp())
      .get('/api/ok')
      .set('X-Request-Id', 'x","level":"info" forged')
      .expect(200);
    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('logs one line per request, without the query string', async () => {
    process.env.NODE_ENV = 'production';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await request(testApp()).get('/api/ok?merchant=SWIGGY&amount=450').expect(200);

    const line = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      level: 'info',
      message: 'request',
      method: 'GET',
      path: '/api/ok',
      status: 200,
      requestId: expect.stringMatching(UUID),
      ms: expect.any(Number),
    });
    expect(JSON.stringify(line)).not.toMatch(/SWIGGY|450/);
  });

  it('does not log a passing health check', async () => {
    process.env.NODE_ENV = 'production';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await request(testApp()).get('/api/health').expect(200);
    expect(out).not.toHaveBeenCalled();
  });
});

describe('an unexpected error', () => {
  it('reaches the caller as an ID, and the log as the full story', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(testApp()).get('/api/boom').expect(500);

    expect(response.body).toEqual({
      error: 'Internal server error',
      requestId: response.headers['x-request-id'],
    });
    // Nothing internal in the response.
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|secret/);

    const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(response.headers['x-request-id']);
    expect(logged).toContain('connection refused');
  });
});

describe('log', () => {
  it('writes JSON in production, for the platform to search', () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    log('warn', '[config] something', { requestId: 'abc' });
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      level: 'warn',
      message: '[config] something',
      requestId: 'abc',
    });
  });

  it('writes a readable line locally', () => {
    process.env.NODE_ENV = 'development';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    log('warn', 'slow', { ms: 1200, userId: undefined });
    expect(warn).toHaveBeenCalledWith('[warn] slow ms=1200');
  });
});
