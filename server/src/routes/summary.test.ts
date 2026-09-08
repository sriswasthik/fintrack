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
  userFindFirst: vi.fn(),
}));

vi.mock('../services/summary/apply', () => service);
vi.mock('../db', () => ({
  getPrisma: () => ({
    account: { findUnique: db.accountFindUnique },
    user: { findFirst: db.userFindFirst },
  }),
}));

import { app } from '../app';

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
  service.getMonthlySummary.mockResolvedValue(RECORD);
  service.regenerateMonthlySummary.mockResolvedValue({ ...RECORD, cached: false });
});

describe('GET /api/summary', () => {
  it('returns the summary for the month asked for', async () => {
    const response = await request(app).get('/api/summary?month=2026-06').expect(200);

    expect(response.body).toEqual(RECORD);
    expect(service.getMonthlySummary).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      userId: 'user_1',
      month: '2026-06',
    });
  });

  it('defaults to the current month', async () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    await request(app).get('/api/summary').expect(200);
    vi.useRealTimers();

    expect(service.getMonthlySummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ month: '2026-07' }),
    );
  });

  it('does not regenerate on a read', async () => {
    await request(app).get('/api/summary?month=2026-06').expect(200);
    expect(service.regenerateMonthlySummary).not.toHaveBeenCalled();
  });

  it('uses the account only to work out whose month this is', async () => {
    db.accountFindUnique.mockResolvedValue({ userId: 'user_2' });

    await request(app).get('/api/summary?month=2026-06&accountId=acct_9').expect(200);

    expect(service.getMonthlySummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: 'user_2' }),
    );
  });

  it('rejects a month that is not a month', async () => {
    await request(app).get('/api/summary?month=2026-13').expect(400);
    await request(app).get('/api/summary?month=June').expect(400);
    expect(service.getMonthlySummary).not.toHaveBeenCalled();
  });

  it('is a 404 when there is no user to summarize', async () => {
    db.userFindFirst.mockResolvedValue(null);
    await request(app).get('/api/summary?month=2026-06').expect(404);
  });
});

describe('POST /api/summary/regenerate', () => {
  it('forces a fresh summary', async () => {
    const response = await request(app).post('/api/summary/regenerate?month=2026-06').expect(200);

    expect(response.body.cached).toBe(false);
    expect(service.regenerateMonthlySummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { userId: 'user_1', month: '2026-06' },
    );
    expect(service.getMonthlySummary).not.toHaveBeenCalled();
  });

  it('validates the month the same way the read does', async () => {
    await request(app).post('/api/summary/regenerate?month=nope').expect(400);
    expect(service.regenerateMonthlySummary).not.toHaveBeenCalled();
  });

  it('is not reachable by GET, so a crawler cannot spend a model call', async () => {
    await request(app).get('/api/summary/regenerate').expect(404);
  });
});
