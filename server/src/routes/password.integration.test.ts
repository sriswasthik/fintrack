/**
 * Forgot / reset / change password, and deleting an account, against a real
 * database (Phase 20).
 *
 * The email provider is stubbed at the same seam the welcome-email suite uses,
 * so the reset link is read out of the message that would have been sent —
 * the whole path, not a token minted behind the endpoint's back.
 *
 * Skips when no DATABASE_URL is configured.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { createPasswordReset } from '../services/auth/passwordReset';
import { REFRESH_COOKIE_NAME } from '../services/auth/tokens';
import { setEmailClient } from '../services/email/send';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'password-flows@fintrack.test';
const GOOGLE_EMAIL = 'password-flows-google@fintrack.test';
const DOOMED_EMAIL = 'password-flows-delete@fintrack.test';
const FIRST_PASSWORD = 'the-first-password';
const SECOND_PASSWORD = 'the-second-password';
const THIRD_PASSWORD = 'the-third-password';

let prisma: PrismaClient;
let sent: { to: string; subject: string; text: string; html: string }[];
const savedEnv = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

const login = (email: string, password: string) =>
  request(app).post('/api/auth/login').send({ email, password });

/** The refresh cookie a response set, as a `Cookie` header value. */
function refreshCookie(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('No refresh cookie was set');
  return cookie.split(';')[0];
}

/** Waits for the background send, then pulls the token out of the link. */
async function tokenFromEmail(to: string): Promise<string> {
  await vi.waitFor(() => expect(sent.some((m) => m.to === to)).toBe(true));
  const message = sent.filter((m) => m.to === to).at(-1)!;
  const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match) throw new Error('No reset link in the email');
  return decodeURIComponent(match[1]);
}

async function cleanUp() {
  await prisma.user.deleteMany({
    where: { email: { in: [EMAIL, GOOGLE_EMAIL, DOOMED_EMAIL] } },
  });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'FinTrack <hello@fintrack.test>';
  await request(app)
    .post('/api/auth/register')
    .send({ email: EMAIL, password: FIRST_PASSWORD })
    .expect(201);
  await prisma.user.create({ data: { email: GOOGLE_EMAIL, googleId: 'google-sub-pw-flows' } });
});

beforeEach(() => {
  sent = [];
  setEmailClient({
    emails: {
      send: vi.fn(async (message: (typeof sent)[number]) => {
        sent.push(message);
        return { data: { id: 'msg_1' }, error: null };
      }),
    },
  } as never);
});

afterAll(async () => {
  setEmailClient(null);
  process.env.RESEND_API_KEY = savedEnv.key;
  process.env.EMAIL_FROM = savedEnv.from;
  if (savedEnv.key === undefined) delete process.env.RESEND_API_KEY;
  if (savedEnv.from === undefined) delete process.env.EMAIL_FROM;
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('forgot and reset password', () => {
  it('answers a real address and a made-up one identically', async () => {
    const real = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: EMAIL })
      .expect(202);
    const fake = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody-here@fintrack.test' })
      .expect(202);
    expect(real.body).toEqual(fake.body);

    await tokenFromEmail(EMAIL);
    expect(sent.map((m) => m.to)).toEqual([EMAIL]);
    expect(sent[0].subject).toBe('Reset your FinTrack password');
  });

  it('stores only a hash of the token', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const token = await tokenFromEmail(EMAIL);
    const rows = await prisma.passwordResetToken.findMany({ where: { user: { email: EMAIL } } });
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.tokenHash))).toBe(true);
  });

  it('retires an older link the moment a newer one is issued', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const older = await tokenFromEmail(EMAIL);
    sent = [];
    await request(app).post('/api/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const newer = await tokenFromEmail(EMAIL);
    expect(newer).not.toBe(older);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: older, password: SECOND_PASSWORD })
      .expect(400);
  });

  it('sets the new password, ends every session, and works exactly once', async () => {
    const session = await login(EMAIL, FIRST_PASSWORD).expect(200);
    const cookie = refreshCookie(session);

    await request(app).post('/api/auth/forgot-password').send({ email: EMAIL }).expect(202);
    const token = await tokenFromEmail(EMAIL);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: SECOND_PASSWORD })
      .expect(200);

    await login(EMAIL, FIRST_PASSWORD).expect(401);
    await login(EMAIL, SECOND_PASSWORD).expect(200);
    // The session from before the reset cannot be renewed.
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    // And the link is spent.
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: THIRD_PASSWORD })
      .expect(400);
  });

  it('refuses an expired link', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const token = await createPasswordReset(prisma, user.id, twoHoursAgo);

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: THIRD_PASSWORD })
      .expect(400);
    expect(response.body.error).toMatch(/expired/);
    await login(EMAIL, SECOND_PASSWORD).expect(200);
  });

  it('gives a Google-only account a way to set its first password', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: GOOGLE_EMAIL }).expect(202);
    const token = await tokenFromEmail(GOOGLE_EMAIL);
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: FIRST_PASSWORD })
      .expect(200);
    await login(GOOGLE_EMAIL, FIRST_PASSWORD).expect(200);
  });
});

describe.skipIf(!hasDatabase)('change password', () => {
  it('reports how the account signs in, without revealing either secret', async () => {
    const session = await login(EMAIL, SECOND_PASSWORD).expect(200);
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(200);
    expect(response.body.user).toMatchObject({ email: EMAIL, hasPassword: true, hasGoogle: false });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('googleId');
  });

  it('refuses a wrong current password with a 400, not a session-ending 401', async () => {
    const session = await login(EMAIL, SECOND_PASSWORD).expect(200);
    const response = await request(app)
      .post('/api/me/password')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ currentPassword: 'not-the-password', newPassword: THIRD_PASSWORD })
      .expect(400);
    expect(response.body.error).toMatch(/current password is incorrect/);
  });

  it('changes it, ends other sessions, and keeps this one signed in', async () => {
    const elsewhere = await login(EMAIL, SECOND_PASSWORD).expect(200);
    const here = await login(EMAIL, SECOND_PASSWORD).expect(200);

    const response = await request(app)
      .post('/api/me/password')
      .set('Authorization', `Bearer ${here.body.accessToken}`)
      .send({ currentPassword: SECOND_PASSWORD, newPassword: THIRD_PASSWORD })
      .expect(200);

    // A fresh session for the person who made the change.
    expect(response.body.accessToken).toEqual(expect.any(String));
    const renewed = refreshCookie(response);
    await request(app).post('/api/auth/refresh').set('Cookie', renewed).expect(200);

    // Every session that existed before is over.
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie(elsewhere))
      .expect(401);

    await login(EMAIL, SECOND_PASSWORD).expect(401);
    await login(EMAIL, THIRD_PASSWORD).expect(200);
  });
});

describe.skipIf(!hasDatabase)('deleting an account', () => {
  let bearer: string;
  let userId: string;

  beforeAll(async () => {
    if (!hasDatabase) return;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email: DOOMED_EMAIL, password: FIRST_PASSWORD })
      .expect(201);
    bearer = `Bearer ${registered.body.accessToken}`;
    userId = registered.body.user.id;

    const account = await request(app)
      .post('/api/accounts')
      .set('Authorization', bearer)
      .send({ name: 'To be deleted', type: 'CHECKING' })
      .expect(201);
    await request(app)
      .post('/api/transactions/commit')
      .set('Authorization', bearer)
      .send({
        accountId: account.body.account.id,
        rows: [
          {
            index: 1,
            date: '2026-05-01',
            description: 'SWIGGY',
            rawMerchant: 'SWIGGY',
            normalizedMerchant: 'SWIGGY',
            amount: 300,
          },
        ],
        resolutions: {},
      })
      .expect(201);
    await request(app)
      .put('/api/budgets/DINING')
      .set('Authorization', bearer)
      .send({ amount: 5000 })
      .expect(200);
  });

  it('needs the email typed out and the password', async () => {
    await request(app)
      .delete('/api/me')
      .set('Authorization', bearer)
      .send({ email: 'someone-else@fintrack.test', password: FIRST_PASSWORD })
      .expect(400);
    await request(app)
      .delete('/api/me')
      .set('Authorization', bearer)
      .send({ email: DOOMED_EMAIL, password: 'not-the-password' })
      .expect(400);
    await request(app)
      .delete('/api/me')
      .set('Authorization', bearer)
      .send({ email: DOOMED_EMAIL })
      .expect(400);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('removes the person and everything they owned', async () => {
    await request(app)
      .delete('/api/me')
      .set('Authorization', bearer)
      .send({ email: DOOMED_EMAIL.toUpperCase(), password: FIRST_PASSWORD })
      .expect(204);

    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.account.count({ where: { userId } })).toBe(0);
    expect(await prisma.transaction.count({ where: { account: { userId } } })).toBe(0);
    expect(await prisma.budget.count({ where: { userId } })).toBe(0);
    expect(await prisma.importBatch.count({ where: { userId } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);

    await login(DOOMED_EMAIL, FIRST_PASSWORD).expect(401);
  });
});
