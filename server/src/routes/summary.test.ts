import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The generation and caching are tested in services/summary/apply.test.ts and
// services/ai/summarize.test.ts. What is exercised here is the HTTP layer —
// query parsing, user scoping, which verb spends a model call — and it runs in
// CI without Postgres or an API key.
const service = vi.hoisted(() => ({
  getMonthlySummary: vi.fn(),
  regenerateMonthlySummary: vi.fn(),
}));

const db = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  accountFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
}));

vi.mock('../services/summary/apply', () => service);
vi.mock('../db', () => ({
  getPrisma: () => ({
    account: { findUnique: db.accountFindUnique, findFirst: db.accountFindFirst },
    user: { findFirst: db.userFindFirst },
  }),
}));

import { app } from '../app';
import { authHeader } from '../test/auth';

const RECORD = {
  month: '2026-06',
  content: 'June was a calmer month...',
  stats: { month: '2026-06', spend: 8959.49, income: 10926.72 },
  source: 'model',
  cached: true,
  stale: false,
  generatedAt: '2026-09-08T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  db.userFindFirst.mockResolvedValue({ id: 'user_1' });
  db.accountFindUnique.mockResolvedValue({ userId: 'user_1' });
  db.accountFindFirst.mockResolvedValue({ id: 'acct_1', userId: 'user_1' });
  service.getMonthlySummary.mockResolvedValue(RECORD);
  service.regenerateMonthlySummary.mockResolvedValue({ ...RECORD, cached: false });
});

describe('GET /api/summary', () => {
  it('returns the summary for the month asked for', async () => {
    const response = await request(app)
      .get('/api/summary?month=2026-06')
      .set(authHeader())
      .expect(200);

    expect(response.body).toEqual(RECORD);
    expect(service.getMonthlySummary).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      userId: 'user_1',
      month: '2026-06',
    });
  });

  it('defaults to the current month', async () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    await request(app).get('/api/summary').set(authHeader()).expect(200);
    vi.useRealTimers();

    expect(service.getMonthlySummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ month: '2026-07' }),
    );
  });

  it('does not regenerate on a read', async () => {
    await request(app).get('/api/summary?month=2026-06').set(authHeader()).expect(200);
    expect(service.regenerateMonthlySummary).not.toHaveBeenCalled();
  });

  it('summarizes the caller-s month, whatever accountId is passed', async () => {
    await request(app)
      .get('/api/summary?month=2026-06&accountId=acct_9')
      .set(authHeader())
      .expect(200);

    expect(service.getMonthlySummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: 'user_1' }),
    );
  });

  it('rejects a month that is not a month', async () => {
    await request(app).get('/api/summary?month=2026-13').set(authHeader()).expect(400);
    await request(app).get('/api/summary?month=June').set(authHeader()).expect(400);
    expect(service.getMonthlySummary).not.toHaveBeenCalled();
  });

  it('404s for an account belonging to somebody else', async () => {
    db.accountFindFirst.mockResolvedValue(null);
    await request(app)
      .get('/api/summary?month=2026-06&accountId=acct_other')
      .set(authHeader())
      .expect(404);
    expect(service.getMonthlySummary).not.toHaveBeenCalled();
  });

  it('401s without a token, so a model call cannot be spent by a stranger', async () => {
    await request(app).get('/api/summary?month=2026-06').expect(401);
    await request(app).post('/api/summary/regenerate?month=2026-06').expect(401);
    expect(service.getMonthlySummary).not.toHaveBeenCalled();
    expect(service.regenerateMonthlySummary).not.toHaveBeenCalled();
  });
});

describe('POST /api/summary/regenerate', () => {
  it('forces a fresh summary', async () => {
    const response = await request(app)
      .post('/api/summary/regenerate?month=2026-06')
      .set(authHeader())
      .expect(200);

    expect(response.body.cached).toBe(false);
    expect(service.regenerateMonthlySummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { userId: 'user_1', month: '2026-06' },
    );
    expect(service.getMonthlySummary).not.toHaveBeenCalled();
  });

  it('validates the month the same way the read does', async () => {
    await request(app).post('/api/summary/regenerate?month=nope').set(authHeader()).expect(400);
    expect(service.regenerateMonthlySummary).not.toHaveBeenCalled();
  });

  it('is not reachable by GET, so a crawler cannot spend a model call', async () => {
    await request(app).get('/api/summary/regenerate').set(authHeader()).expect(404);
  });
});
