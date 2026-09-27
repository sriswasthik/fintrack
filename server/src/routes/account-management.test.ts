/**
 * The Phase 20 routes, at the protocol level: who may call them, what a demo
 * session is refused, and what is rejected before any query runs. The
 * database behaviour — cascades, re-pairing, the arithmetic — is proven
 * against Postgres in the `*.integration.test.ts` suites beside this one.
 *
 * Prisma is a mock with nothing on it, so a route that reached the database
 * here would fail the test with a 500 rather than pass it by accident.
 */
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../db', () => ({ getPrisma: () => prismaMock }));

import { app } from '../app';
import { csvSafe } from '../controllers/transactions';
import { merchantOfPattern } from '../controllers/rules';
import { signAccessToken } from '../services/auth/tokens';
import { authHeader } from '../test/auth';

const demoHeader = () => ({
  Authorization: `Bearer ${signAccessToken('user_demo', { demo: true })}`,
});

/** Every route this phase added that needs a session, with a method and a body. */
const PROTECTED: [method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string][] = [
  ['patch', '/api/accounts/acct_1'],
  ['delete', '/api/accounts/acct_1'],
  ['get', '/api/imports'],
  ['delete', '/api/imports/imp_1'],
  ['get', '/api/rules'],
  ['patch', '/api/rules/rule_1'],
  ['delete', '/api/rules/rule_1'],
  ['get', '/api/budgets'],
  ['put', '/api/budgets/DINING'],
  ['delete', '/api/budgets/DINING'],
  ['get', '/api/transactions/export'],
  ['post', '/api/me/password'],
  ['delete', '/api/me'],
];

describe('the Phase 20 routes', () => {
  it.each(PROTECTED)('%s %s needs a session', async (method, path) => {
    const response = await request(app)[method](path).send({});
    expect(response.status).toBe(401);
  });

  it.each(PROTECTED.filter(([method]) => method !== 'get'))(
    '%s %s is refused to a demo session before it can touch anything',
    async (method, path) => {
      const response = await request(app)[method](path).set(demoHeader()).send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/read-only/i);
    },
  );
});

describe('validation before any query', () => {
  it('refuses a budget on a category a budget makes no sense for', async () => {
    for (const category of ['INCOME', 'TRANSFER', 'REFUND']) {
      const response = await request(app)
        .put(`/api/budgets/${category}`)
        .set(authHeader())
        .send({ amount: 5000 })
        .expect(400);
      expect(response.body.error).toMatch(/cannot be set/);
    }
  });

  it('refuses a category that does not exist', async () => {
    await request(app).put('/api/budgets/SNACKS').set(authHeader()).send({ amount: 1 }).expect(400);
  });

  it('refuses a budget of zero or less', async () => {
    await request(app).put('/api/budgets/DINING').set(authHeader()).send({ amount: 0 }).expect(400);
    await request(app)
      .put('/api/budgets/DINING')
      .set(authHeader())
      .send({ amount: -100 })
      .expect(400);
  });

  it('refuses an export given a month and a range at once', async () => {
    await request(app)
      .get('/api/transactions/export')
      .query({ month: '2026-06', from: '2026-06-01' })
      .set(authHeader())
      .expect(400);
  });

  it('refuses an export whose range runs backwards', async () => {
    await request(app)
      .get('/api/transactions/export')
      .query({ from: '2026-06-30', to: '2026-06-01' })
      .set(authHeader())
      .expect(400);
  });

  it('refuses a new password that is too short', async () => {
    await request(app)
      .post('/api/me/password')
      .set(authHeader())
      .send({ currentPassword: 'whatever-it-was', newPassword: 'short' })
      .expect(400);
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'abc', password: 'short' })
      .expect(400);
  });

  it('refuses a forgot-password request with no usable address', async () => {
    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' })
      .expect(400);
  });

  it('says reset is unavailable, rather than promising an email, when none can be sent', async () => {
    const saved = { ...process.env };
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    try {
      // The database mock is empty: answering without it is what makes this
      // the same response for every address.
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'someone@example.com' })
        .expect(503);
      expect(response.body.error).toMatch(/not available on this server/);
    } finally {
      process.env = saved;
    }
  });

  it('refuses an account update that changes nothing', async () => {
    await request(app).patch('/api/accounts/acct_1').set(authHeader()).send({}).expect(400);
  });
});

describe('csvSafe', () => {
  it('neutralises anything a spreadsheet would run as a formula', () => {
    expect(csvSafe('=HYPERLINK("http://evil.test","click")')).toBe(
      `'=HYPERLINK("http://evil.test","click")`,
    );
    expect(csvSafe('+91 98450 12345')).toBe(`'+91 98450 12345`);
    expect(csvSafe('-SUM(A1)')).toBe(`'-SUM(A1)`);
    expect(csvSafe('@cmd')).toBe(`'@cmd`);
    expect(csvSafe('\tTAB')).toBe(`'\tTAB`);
  });

  it('leaves an ordinary narration alone', () => {
    expect(csvSafe('UPI/SWIGGY/412345678901')).toBe('UPI/SWIGGY/412345678901');
    expect(csvSafe('AMAZON PAY - GROCERIES')).toBe('AMAZON PAY - GROCERIES');
  });
});

describe('merchantOfPattern', () => {
  it('recovers the merchant a learned rule was written for', () => {
    expect(merchantOfPattern('^THE ADDA$')).toBe('THE ADDA');
  });

  it('un-escapes what the override endpoint escaped', () => {
    expect(merchantOfPattern('^A\\.B\\+C \\(INDIA\\)$')).toBe('A.B+C (INDIA)');
  });

  it('declines a pattern of any other shape', () => {
    expect(merchantOfPattern('SWIGGY')).toBeNull();
    expect(merchantOfPattern('^SWIGGY')).toBeNull();
  });
});
