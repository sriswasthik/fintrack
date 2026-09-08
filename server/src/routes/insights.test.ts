import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The detection itself is tested against the seeded dataset in
// services/anomalies/detect.test.ts. What is exercised here is the HTTP layer
// around it — query parsing, user scoping, status codes — which runs in CI
// without Postgres.
const service = vi.hoisted(() => ({
  refreshAnomalies: vi.fn(),
  listInsights: vi.fn(),
  dismissInsight: vi.fn(),
}));

const db = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
}));

vi.mock('../services/anomalies/apply', () => service);

vi.mock('../db', () => ({
  getPrisma: () => ({
    account: { findUnique: db.accountFindUnique },
    user: { findFirst: db.userFindFirst },
  }),
}));

import { app } from '../app';

const INSIGHT = {
  id: 'flag_1',
  type: 'UNUSUAL_AMOUNT',
  severity: 'HIGH',
  month: '2026-05',
  explanation: '$3,299.00 at APPLE STORE is unusually large for SHOPPING.',
  transactionId: 'txn_1',
  createdAt: '2026-09-08T00:00:00.000Z',
  transaction: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.userFindFirst.mockResolvedValue({ id: 'user_1' });
  db.accountFindUnique.mockResolvedValue({ userId: 'user_1' });
  service.refreshAnomalies.mockResolvedValue({
    month: '2026-05',
    detected: 1,
    created: 1,
    updated: 0,
    cleared: 0,
  });
  service.listInsights.mockResolvedValue([INSIGHT]);
  service.dismissInsight.mockResolvedValue(true);
});

describe('GET /api/insights', () => {
  it('returns the active flags for the month asked for', async () => {
    const response = await request(app).get('/api/insights?month=2026-05').expect(200);

    expect(response.body).toEqual({ month: '2026-05', insights: [INSIGHT], detected: 1 });
    expect(service.listInsights).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user_1',
      month: '2026-05',
    });
  });

  it('recomputes the month before answering, so the panel is never stale', async () => {
    await request(app).get('/api/insights?month=2026-05').expect(200);

    expect(service.refreshAnomalies).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user_1',
      month: '2026-05',
    });
    expect(service.refreshAnomalies.mock.invocationCallOrder[0]).toBeLessThan(
      service.listInsights.mock.invocationCallOrder[0],
    );
  });

  it('defaults to the current month', async () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    const response = await request(app).get('/api/insights').expect(200);
    vi.useRealTimers();

    expect(response.body.month).toBe('2026-07');
  });

  it('uses the account only to work out whose insights these are', async () => {
    db.accountFindUnique.mockResolvedValue({ userId: 'user_2' });

    await request(app).get('/api/insights?month=2026-05&accountId=acct_9').expect(200);

    expect(db.accountFindUnique).toHaveBeenCalledWith({
      where: { id: 'acct_9' },
      select: { userId: true },
    });
    expect(service.listInsights).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user_2',
      month: '2026-05',
    });
  });

  it('rejects a month that is not a month', async () => {
    await request(app).get('/api/insights?month=2026-13').expect(400);
    await request(app).get('/api/insights?month=June').expect(400);
    expect(service.refreshAnomalies).not.toHaveBeenCalled();
  });

  it('is a 404 when there is no user to answer for', async () => {
    db.userFindFirst.mockResolvedValue(null);
    await request(app).get('/api/insights?month=2026-05').expect(404);
  });
});

describe('DELETE /api/insights/:id', () => {
  it('dismisses the flag and answers 204', async () => {
    await request(app).delete('/api/insights/flag_1').expect(204);

    expect(service.dismissInsight).toHaveBeenCalledWith(expect.anything(), {
      id: 'flag_1',
      userId: 'user_1',
    });
  });

  it('is a 404 when there is nothing to dismiss', async () => {
    service.dismissInsight.mockResolvedValue(false);
    await request(app).delete('/api/insights/flag_1').expect(404);
  });

  it('does not re-run detection', async () => {
    await request(app).delete('/api/insights/flag_1').expect(204);
    expect(service.refreshAnomalies).not.toHaveBeenCalled();
  });
});
