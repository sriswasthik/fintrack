import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../app';
import { authHeader } from '../test/auth';

describe('GET /api/health', () => {
  it('responds 200 with { status: "ok" }', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown API routes, to a caller who is signed in', async () => {
    const response = await request(app).get('/api/does-not-exist').set(authHeader());

    expect(response.status).toBe(404);
  });

  it('returns 401 rather than 404 for an unknown route to a stranger', async () => {
    // requireAuth is mounted on the whole data surface, so it answers before
    // the not-found handler is reached. That is the behaviour we want: the
    // shape of the API is not something to hand out unauthenticated.
    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(401);
  });
});
