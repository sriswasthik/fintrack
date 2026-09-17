/**
 * The welcome email, at the HTTP level (Phase 17).
 *
 * `templates/welcome.test.ts` proves the message is well-formed and
 * `send.test.ts` proves the transport never throws. What is left — and what the
 * phase is actually about — is *who gets one and when*, and that is a property
 * of the two routes, not of either module:
 *
 *   * registration sends one, a Google sign-up sends one
 *   * an ordinary login sends none, and neither does Google linking to an
 *     account that already existed or signing an existing one back in
 *   * a broken mail provider is invisible from the outside: the registration
 *     still returns 201, the account still exists, and the session still works
 *
 * Resend is stubbed — the seam is `setEmailClient`, so everything above the
 * HTTPS call is the real code path. Google's verifier is stubbed for the same
 * reason it is in google.integration.test.ts: a live token would have to be
 * signed by Google's keys.
 *
 * Skips when no DATABASE_URL is configured; CI runs it against a service
 * container (see .github/workflows/ci.yml).
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { setGoogleOAuthClient } from '../services/auth/google';
import { setEmailClient } from '../services/email/send';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAILS = ['welcome-new@fintrack.test', 'welcome-existing@fintrack.test'];
const PASSWORD = 'a-password-long-enough';

let prisma: PrismaClient;

/** Every message handed to the provider during a test. */
interface Sent {
  to: string;
  subject: string;
  html: string;
  text: string;
}
let sent: Sent[];

/**
 * Stands in for the Resend SDK.
 *
 * `outcome` is what the provider answers with, which is where a failure is
 * simulated: Resend reports a refusal — an invalid API key among them — in the
 * `error` field rather than by throwing.
 */
function stubResend(
  outcome: () => Promise<unknown> = () => Promise.resolve({ data: { id: 'msg_1' }, error: null }),
) {
  const send = vi.fn((message: Sent) => {
    sent.push(message);
    return outcome();
  });
  setEmailClient({ emails: { send } } as never);
  return send;
}

/** Stands in for Google's verifier, as in google.integration.test.ts. */
function stubGoogle(payload: Record<string, unknown>) {
  setGoogleOAuthClient({
    verifyIdToken: vi.fn(async () => ({ getPayload: () => payload })),
  } as never);
}

const googlePayload = (over: Record<string, unknown> = {}) => ({
  sub: 'welcome-sub-0001',
  email: 'welcome-new@fintrack.test',
  email_verified: true,
  name: 'Ada Lovelace',
  ...over,
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the background send to reach the provider.
 *
 * It is queued after the response is written, so by the time supertest resolves
 * it may not have run yet — that lag is the feature, not a race in the test.
 */
async function settled(count = 1, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < count && Date.now() < deadline) await pause(5);
}

/** Gives a send that must NOT happen every chance to happen anyway. */
const quiet = () => pause(150);

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();
}, 30000);

beforeEach(() => {
  sent = [];
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'FinTrack <hello@fintrack.test>';
  process.env.APP_URL = 'https://app.fintrack.test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  stubResend();
});

afterEach(async () => {
  setEmailClient(null);
  setGoogleOAuthClient(null);
  vi.restoreAllMocks();
  delete process.env.APP_URL;
  if (!hasDatabase) return;
  await cleanUp();
});

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

const registerNew = () =>
  request(app)
    .post('/api/auth/register')
    .send({ email: 'welcome-new@fintrack.test', password: PASSWORD, name: 'Ada Lovelace' });

describe.skipIf(!hasDatabase)('POST /api/auth/register', () => {
  it('welcomes the new account', async () => {
    await registerNew().expect(201);
    await settled();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('welcome-new@fintrack.test');
    // Energetic but legitimate: no shouting, and something a person can read in
    // an inbox list. The spam-safety rules are asserted in the template's tests.
    expect(sent[0].subject).toBe('Welcome to FinTrack — your money, finally organised');
    expect(sent[0].html).toContain('Ada');
    // Both parts, every time — a message with no text part is itself a signal.
    expect(sent[0].text).toContain('FinTrack');
    // The link points at the deployment, not at a developer's laptop.
    expect(sent[0].html).toContain('https://app.fintrack.test/login');
  });

  it('answers before the provider does', async () => {
    // The fire-and-forget claim, stated as the thing that would break if it
    // were awaited: a provider that never answers.
    let release = () => {};
    const hang = new Promise((resolve) => {
      release = () => resolve({ data: { id: 'msg_1' }, error: null });
    });
    stubResend(() => hang);

    // If the send were awaited before the response, this line would never
    // return and the test would fail on its timeout rather than an assertion.
    const started = Date.now();
    await registerNew().expect(201);
    expect(Date.now() - started).toBeLessThan(2000);

    await settled();
    expect(sent).toHaveLength(1);
    release();
  });

  it('sends exactly one, and never again on login', async () => {
    await registerNew().expect(201);
    await settled();

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'welcome-new@fintrack.test', password: PASSWORD })
      .expect(200);
    await quiet();

    // Signing in is not signing up. This is the whole of requirement 3's
    // "never send it again on a normal login".
    expect(sent).toHaveLength(1);
  });

  it('does not welcome an address that was refused', async () => {
    await registerNew().expect(201);
    await settled();

    await registerNew().expect(409);
    await quiet();

    expect(sent).toHaveLength(1);
  });
});

describe.skipIf(!hasDatabase)('POST /api/auth/google', () => {
  it('welcomes an account Google created', async () => {
    stubGoogle(googlePayload());

    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(201);
    expect(response.body.isNewUser).toBe(true);
    await settled();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('welcome-new@fintrack.test');
  });

  it('does not welcome an account that only linked Google', async () => {
    // The case Phase 16's flag exists for. This person has had an account since
    // they set that password; a new button is not a new account.
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'welcome-existing@fintrack.test', password: PASSWORD })
      .expect(201);
    await settled();
    sent = [];

    stubGoogle(googlePayload({ sub: 'welcome-sub-0002', email: 'welcome-existing@fintrack.test' }));
    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(200);
    expect(response.body).toMatchObject({ isNewUser: false, resolution: 'linked' });
    await quiet();

    expect(sent).toEqual([]);
  });

  it('does not welcome a repeat Google sign-in', async () => {
    stubGoogle(googlePayload());
    await request(app).post('/api/auth/google').send({ credential: 'an-id-token' }).expect(201);
    await settled();
    sent = [];

    await request(app).post('/api/auth/google').send({ credential: 'an-id-token' }).expect(200);
    await quiet();

    expect(sent).toEqual([]);
  });

  it('does not welcome a sign-in Google would not verify', async () => {
    setGoogleOAuthClient({
      verifyIdToken: vi.fn(() => Promise.reject(new Error('Invalid token signature'))),
    } as never);

    await request(app).post('/api/auth/google').send({ credential: 'forged' }).expect(401);
    await quiet();

    expect(sent).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)('when sending fails', () => {
  /** Registers, waits for the send to be attempted, and returns the response. */
  async function registerThroughFailure() {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await registerNew().expect(201);
    await settled();
    await quiet();
    return { response, errors };
  }

  it('still registers when the API key is rejected', async () => {
    // Exactly what a temporarily invalid RESEND_API_KEY looks like coming back
    // from the SDK: a refusal in `error`, not a thrown exception.
    stubResend(() =>
      Promise.resolve({
        data: null,
        error: { name: 'validation_error', message: 'API key is invalid' },
      }),
    );

    const { response, errors } = await registerThroughFailure();

    expect(response.status).toBe(201);
    expect(response.body.accessToken).toEqual(expect.any(String));
    // The account is real: a failed courtesy email rolls nothing back.
    expect(await prisma.user.count({ where: { email: 'welcome-new@fintrack.test' } })).toBe(1);
    // Logged server-side, which is the only place anyone can see it.
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('API key is invalid'));
  });

  it('still registers when the provider throws', async () => {
    stubResend(() => Promise.reject(new Error('socket hang up')));

    const { response, errors } = await registerThroughFailure();

    expect(response.status).toBe(201);
    expect(await prisma.user.count({ where: { email: 'welcome-new@fintrack.test' } })).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('leaves a working session behind when the send fails', async () => {
    stubResend(() => Promise.reject(new Error('socket hang up')));
    const { response } = await registerThroughFailure();

    // Nothing about the response is degraded — the person is signed in.
    const me = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${response.body.accessToken}` })
      .expect(200);
    expect(me.body.user.email).toBe('welcome-new@fintrack.test');
  });

  it('still registers on a deployment that cannot send mail at all', async () => {
    // The ordinary local case: no key configured. Not an error, and not a
    // reason to refuse a registration.
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registerNew().expect(201);
    await quiet();

    expect(sent).toEqual([]);
    expect(await prisma.user.count({ where: { email: 'welcome-new@fintrack.test' } })).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('skipping send'));
  });
});
