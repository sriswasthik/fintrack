import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../app';

describe('GET /api/health', () => {
  it('responds 200 with { status: "ok" }', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown API routes', async () => {
    const response = await request(app).get('/api/does-not-exist');

    expect(response.status).toBe(404);
  });
});
