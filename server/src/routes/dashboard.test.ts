import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The aggregation is one raw SQL statement; the query itself is verified against
// a live database by hand (see the pull request). What is mocked here is the
// database, so the request handling around it — window resolution, filter
// parsing, response shape — runs in CI without Postgres.
const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  accountFindUnique: vi.fn(),
  accountFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
}));

vi.mock('../db', () => ({
  getPrisma: () => ({
    $queryRaw: db.queryRaw,
    account: { findUnique: db.accountFindUnique, findFirst: db.accountFindFirst },
    user: { findFirst: db.userFindFirst },
  }),
}));

import { app } from '../app';
import { authHeader } from '../test/auth';

const EMPTY_ROW = {
  totals: { spend: '0', income: '0', transactions: '0' },
  previous: { spend: '0', income: '0', transactions: '0' },
  by_category: null,
  series: null,
  top_merchants: null,
  available_months: null,
};

/** Pulls the interpolated values out of the tagged-template call. */
function queryValues(): unknown[] {
  return db.queryRaw.mock.calls[0].slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.userFindFirst.mockResolvedValue({ id: 'user_1' });
  db.accountFindUnique.mockResolvedValue({ userId: 'user_1' });
  db.accountFindFirst.mockResolvedValue({ id: 'acct_1', userId: 'user_1' });
  db.queryRaw.mockResolvedValue([EMPTY_ROW]);
});

describe('GET /api/dashboard', () => {
  it('resolves a month into a half-open window and the previous calendar month', async () => {
    const response = await request(app)
      .get('/api/dashboard?month=2026-06')
      .set(authHeader())
      .expect(200);

    expect(response.body.range).toMatchObject({
      from: '2026-06-01',
      to: '2026-06-30',
      month: '2026-06',
      granularity: 'daily',
    });
    expect(response.body.previousRange).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });

  it('makes exactly one aggregation query, not one per card', async () => {
    await request(app).get('/api/dashboard?month=2026-06').set(authHeader()).expect(200);
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('passes filters as bound parameters rather than interpolated SQL', async () => {
    await request(app)
      .get('/api/dashboard?month=2026-06&accountId=acct_1&categories=DINING,GROCERIES')
      .set(authHeader())
      .expect(200);

    const values = queryValues();
    expect(values).toContain('user_1');
    expect(values).toContain('acct_1');
    expect(values).toContainEqual(['DINING', 'GROCERIES']);
  });

  it('sends null for an absent filter, so the query can short-circuit it', async () => {
    await request(app).get('/api/dashboard?month=2026-06').set(authHeader()).expect(200);
    expect(queryValues()).toContain(null);
  });

  it('accepts repeated category params as well as a comma-separated list', async () => {
    await request(app)
      .get('/api/dashboard?month=2026-06&categories=DINING&categories=TRAVEL')
      .set(authHeader())
      .expect(200);

    expect(queryValues()).toContainEqual(['DINING', 'TRAVEL']);
  });

  it('aggregates for the token holder, never for whoever the accountId belongs to', async () => {
    await request(app)
      .get('/api/dashboard?month=2026-06&accountId=acct_1')
      .set(authHeader())
      .expect(200);

    // Before Phase 9 the accountId decided whose data this was, which is how a
    // request reached another account by naming it. It is now only a filter,
    // checked against the caller.
    expect(queryValues()).toContain('user_1');
    expect(db.accountFindFirst).toHaveBeenCalledWith({
      where: { id: 'acct_1', userId: 'user_1' },
      select: { id: true },
    });
  });

  it('supports a custom range, compared with the preceding window of equal length', async () => {
    const response = await request(app)
      .get('/api/dashboard?from=2026-06-11&to=2026-06-20')
      .set(authHeader())
      .expect(200);

    expect(response.body.range).toMatchObject({
      from: '2026-06-11',
      to: '2026-06-20',
      month: null,
    });
    expect(response.body.previousRange).toEqual({ from: '2026-06-01', to: '2026-06-10' });
  });

  it('switches the time-series bucket for weekly granularity', async () => {
    await request(app)
      .get('/api/dashboard?month=2026-06&granularity=weekly')
      .set(authHeader())
      .expect(200);
    expect(queryValues()).toContain('week');

    vi.clearAllMocks();
    db.userFindFirst.mockResolvedValue({ id: 'user_1' });
    db.queryRaw.mockResolvedValue([EMPTY_ROW]);
    await request(app).get('/api/dashboard?month=2026-06').set(authHeader()).expect(200);
    expect(queryValues()).toContain('day');
  });

  it('shapes an empty month into zeroes rather than nulls', async () => {
    const response = await request(app)
      .get('/api/dashboard?month=2026-06')
      .set(authHeader())
      .expect(200);

    expect(response.body.totals).toEqual({ spend: 0, income: 0, net: 0, transactions: 0 });
    expect(response.body.deltas).toEqual({ spend: null, income: null });
    expect(response.body.byCategory).toEqual([]);
    expect(response.body.series).toEqual([]);
    expect(response.body.topMerchants).toEqual([]);
  });

  it('converts the numeric strings Postgres returns and computes shares and deltas', async () => {
    db.queryRaw.mockResolvedValue([
      {
        totals: { spend: '8959.49', income: '10926.72', transactions: '111' },
        previous: { spend: '13295.66', income: '8225.77', transactions: '124' },
        by_category: [
          { category: 'HOUSING', amount: '2150.00', transactions: '1' },
          { category: 'SHOPPING', amount: '1945.84', transactions: '18' },
          { category: 'INCOME', amount: '-10926.72', transactions: '4' },
        ],
        series: [{ bucket_start: '2026-06-01', spend: '120.55' }],
        top_merchants: [
          { merchant: 'OAKWOOD PROPERTY MGMT', amount: '2150.00', transactions: '1' },
        ],
        available_months: ['2026-06', '2026-05'],
      },
    ]);

    const response = await request(app)
      .get('/api/dashboard?month=2026-06')
      .set(authHeader())
      .expect(200);

    expect(response.body.totals).toEqual({
      spend: 8959.49,
      income: 10926.72,
      net: 1967.23,
      transactions: 111,
    });
    expect(response.body.deltas).toEqual({ spend: -32.6, income: 32.8 });
    // Share is of gross spending, so INCOME does not distort it and never
    // reports a negative percentage.
    const byCategory = response.body.byCategory;
    expect(byCategory[0]).toMatchObject({ category: 'HOUSING', share: 52.5 });
    expect(byCategory.find((c: { category: string }) => c.category === 'INCOME').share).toBe(0);
    expect(response.body.series).toEqual([{ date: '2026-06-01', spend: 120.55 }]);
    expect(response.body.availableMonths).toEqual(['2026-05', '2026-06']);
  });

  it.each([
    ['a malformed month', '?month=June'],
    ['a month out of range', '?month=2026-13'],
    ['a category outside the taxonomy', '?month=2026-06&categories=SNACKS'],
    ['an unknown granularity', '?month=2026-06&granularity=hourly'],
    ['a half-supplied range', '?from=2026-06-01'],
  ])('rejects %s', async (_label, query) => {
    await request(app).get(`/api/dashboard${query}`).set(authHeader()).expect(400);
  });

  it('404s for an account belonging to somebody else', async () => {
    // findFirst is scoped by userId, so another user's account simply is not
    // found — the caller cannot tell it from an id that never existed.
    db.accountFindFirst.mockResolvedValue(null);
    await request(app)
      .get('/api/dashboard?month=2026-06&accountId=acct_other')
      .set(authHeader())
      .expect(404);
    expect(db.queryRaw).not.toHaveBeenCalled();
  });

  it('401s without a token', async () => {
    await request(app).get('/api/dashboard?month=2026-06').expect(401);
    expect(db.queryRaw).not.toHaveBeenCalled();
  });
});
