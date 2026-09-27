import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same mocking approach as auth.test.ts: no Postgres, so what is tested here is
// the protocol — who gets a demo session, what it is allowed to do, and what a
// deployment that has not opted in answers.
const db = vi.hoisted(() => ({ userFindUnique: vi.fn() }));

const prismaMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../db', () => ({ getPrisma: () => prismaMock }));

import { app } from '../app';
import { REFRESH_COOKIE_NAME, signAccessToken } from '../services/auth/tokens';

const DEMO_USER = { id: 'user_demo', email: 'demo@fintrack.local', name: 'Demo User' };

/** A bearer header for a read-only demo session. */
const demoHeader = () => ({
  Authorization: `Bearer ${signAccessToken(DEMO_USER.id, { demo: true })}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEMO_MODE = 'on';
  db.userFindUnique.mockResolvedValue(DEMO_USER);
  Object.assign(prismaMock, { user: { findUnique: db.userFindUnique } });
});

describe('POST /api/auth/demo', () => {
  it('hands a stranger a session with no password', async () => {
    const response = await request(app).post('/api/auth/demo').expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user).toEqual(DEMO_USER);
    expect(response.body.demo).toBe(true);
  });

  it('sets no refresh cookie, so nothing persists in the visitor’s browser', async () => {
    const response = await request(app).post('/api/auth/demo').expect(200);

    const cookies = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(cookies.some((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`))).toBe(false);
  });

  it('lasts longer than a normal access token, having nothing to refresh from', async () => {
    const response = await request(app).post('/api/auth/demo').expect(200);

    expect(response.body.expiresIn).toBeGreaterThan(15 * 60);
  });

  it('is not offered at all unless the deployment opted in', async () => {
    delete process.env.DEMO_MODE;

    await request(app).post('/api/auth/demo').expect(404);
    expect(db.userFindUnique).not.toHaveBeenCalled();
  });

  it('says so when demo mode is on but nothing has been seeded', async () => {
    db.userFindUnique.mockResolvedValue(null);

    const response = await request(app).post('/api/auth/demo').expect(503);

    expect(response.body.error).toMatch(/seeded/i);
  });
});

describe('a demo session is read-only', () => {
  // Any write would let one anonymous visitor change what the next one sees.
  const writes: [string, string][] = [
    ['post', '/api/transactions/commit'],
    ['post', '/api/transactions/categorize'],
    ['post', '/api/transactions/txn_1/category'],
    ['post', '/api/transactions/txn_1/split'],
    ['delete', '/api/transactions/txn_1/split'],
    ['post', '/api/summary/regenerate'],
    ['post', '/api/accounts'],
    ['delete', '/api/insights/flag_1'],
  ];

  it.each(writes)('refuses %s %s with 403', async (method, path) => {
    const response = await request(app)
      [method as 'post' | 'delete'](path)
      .set(demoHeader())
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/read-only/i);
  });

  it('still reads, which is the entire point of it', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'acct_1',
        name: 'Everyday Checking',
        type: 'CHECKING',
        createdAt: new Date(),
        _count: { transactions: 3 },
      },
    ]);
    Object.assign(prismaMock, {
      user: { findUnique: db.userFindUnique },
      account: { findMany },
    });

    const response = await request(app).get('/api/accounts').set(demoHeader()).expect(200);

    expect(response.body.accounts).toHaveLength(1);
    // Scoped to the demo user like any other session — nothing special here.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_demo' } }),
    );
  });

  it('refuses the write before the handler can touch the database', async () => {
    // The guard sits in front of every data route, so a demo write never
    // reaches a query — not even one that would have been scoped correctly.
    Object.assign(prismaMock, {
      user: { findUnique: db.userFindUnique },
      account: {
        findFirst: vi.fn(() => {
          throw new Error('the handler should never have run');
        }),
      },
    });

    await request(app)
      .post('/api/transactions/categorize')
      .set(demoHeader())
      .send({ accountId: 'acct_1' })
      .expect(403);
  });
});
