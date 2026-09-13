/**
 * Google Sign-In against a real database.
 *
 * The whole feature is a claim about *which row* a sign-in lands on, and rows
 * are what a mocked Prisma does not have. The linking case in particular — an
 * account that already exists with a password, reached through Google — is a
 * claim that no second row appears, which cannot be asserted against a stub
 * that was told what to return.
 *
 * Google itself is stubbed: reaching the real verifier would need a live token
 * signed by Google's keys. What is stubbed is the network, not the logic — the
 * identity that comes back is fed through exactly the resolution code the route
 * uses, and `verifyGoogleIdToken` has its own unit tests for the checks it runs
 * on a payload.
 *
 * Skips when no DATABASE_URL is configured; CI runs it against a service
 * container (see .github/workflows/ci.yml).
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app';
import { createPrismaClient } from '../../db';
import type { PrismaClient } from '../../generated/prisma/client';
import { hashPassword } from './passwords';
import { resolveGoogleUser, setGoogleOAuthClient, type GoogleIdentity } from './google';
import { REFRESH_COOKIE_NAME } from './tokens';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAILS = [
  'google-new@fintrack.test',
  'google-linked@fintrack.test',
  'google-repeat@fintrack.test',
  'google-changed@fintrack.test',
];

const PASSWORD = 'a-password-long-enough';

let prisma: PrismaClient;

/** A verified identity, as `verifyGoogleIdToken` would return it. */
const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  googleId: 'google-sub-0001',
  email: 'google-new@fintrack.test',
  name: 'Ada Lovelace',
  picture: 'https://lh3.googleusercontent.com/a/ada',
  ...over,
});

/**
 * Stands in for Google's verifier.
 *
 * The stub returns whatever payload the test hands it, so the route exercises
 * its own parsing, its own `email_verified` check and its own resolution — only
 * the signature check and the network call are replaced.
 */
function stubGoogle(payload: Record<string, unknown> | null) {
  setGoogleOAuthClient({
    verifyIdToken: vi.fn(async () => ({ getPayload: () => payload ?? undefined })),
  } as never);
}

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();
}, 30000);

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
});

afterEach(async () => {
  if (!hasDatabase) return;
  setGoogleOAuthClient(null);
  await cleanUp();
});

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('resolveGoogleUser', () => {
  it('creates an account with no password when nobody matches', async () => {
    const resolved = await resolveGoogleUser(prisma, identity());

    expect(resolved).toMatchObject({ resolution: 'created', isNewUser: true });
    expect(resolved.user.email).toBe('google-new@fintrack.test');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: resolved.user.id },
      select: { passwordHash: true, googleId: true, name: true, picture: true },
    });
    // The point of the phase: signing up purely with Google sets no password.
    expect(row.passwordHash).toBeNull();
    expect(row.googleId).toBe('google-sub-0001');
    expect(row.name).toBe('Ada Lovelace');
    expect(row.picture).toBe('https://lh3.googleusercontent.com/a/ada');
  });

  it('links Google to an account that already signed up with a password', async () => {
    // The case worth proving. This account has a password and no googleId; the
    // same human then clicks "Sign in with Google" with the same address.
    const original = await prisma.user.create({
      data: {
        email: 'google-linked@fintrack.test',
        passwordHash: await hashPassword(PASSWORD),
        name: 'Grace Hopper',
      },
      select: { id: true, passwordHash: true },
    });

    const resolved = await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0002', email: 'google-linked@fintrack.test' }),
    );

    expect(resolved.resolution).toBe('linked');
    // Not a new user: they have been here since they set that password, and
    // Phase 17 must not welcome them.
    expect(resolved.isNewUser).toBe(false);
    // The *same row*, not a second one.
    expect(resolved.user.id).toBe(original.id);

    const rows = await prisma.user.findMany({
      where: { email: 'google-linked@fintrack.test' },
      select: { id: true, googleId: true, passwordHash: true, name: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].googleId).toBe('google-sub-0002');
    // Linking adds a way in; it does not take the old one away.
    expect(rows[0].passwordHash).toBe(original.passwordHash);
    // A name the account already had is not overwritten by Google's copy.
    expect(rows[0].name).toBe('Grace Hopper');
  });

  it('keeps the password working after linking', async () => {
    await prisma.user.create({
      data: {
        email: 'google-linked@fintrack.test',
        passwordHash: await hashPassword(PASSWORD),
      },
    });
    await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0002', email: 'google-linked@fintrack.test' }),
    );

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'google-linked@fintrack.test', password: PASSWORD })
      .expect(200);
  });

  it('signs an existing Google account straight back in', async () => {
    const first = await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0003', email: 'google-repeat@fintrack.test' }),
    );
    const second = await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0003', email: 'google-repeat@fintrack.test' }),
    );

    expect(second).toMatchObject({ resolution: 'signed-in', isNewUser: false });
    expect(second.user.id).toBe(first.user.id);
    expect(await prisma.user.count({ where: { email: 'google-repeat@fintrack.test' } })).toBe(1);
  });

  it('follows the Google id when the address behind it changes', async () => {
    // A Google `sub` outlives an email address. Matching on the id first is
    // what keeps somebody's data when they change their Gmail address.
    const first = await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0004', email: 'google-repeat@fintrack.test' }),
    );
    const second = await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0004', email: 'google-changed@fintrack.test' }),
    );

    expect(second.user.id).toBe(first.user.id);
    expect(second.resolution).toBe('signed-in');
  });

  it('fills in a name the account never had', async () => {
    await prisma.user.create({
      data: { email: 'google-linked@fintrack.test', passwordHash: await hashPassword(PASSWORD) },
    });

    const resolved = await resolveGoogleUser(
      prisma,
      identity({ googleId: 'google-sub-0005', email: 'google-linked@fintrack.test' }),
    );

    expect(resolved.user.name).toBe('Ada Lovelace');
  });
});

describe.skipIf(!hasDatabase)('POST /api/auth/google', () => {
  const verified = (over: Record<string, unknown> = {}) => ({
    sub: 'google-sub-0001',
    email: 'google-new@fintrack.test',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/ada',
    ...over,
  });

  it('creates a session for a brand-new user and says so', async () => {
    stubGoogle(verified());

    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(201);

    expect(response.body).toMatchObject({
      isNewUser: true,
      resolution: 'created',
      demo: false,
      user: { email: 'google-new@fintrack.test', name: 'Ada Lovelace' },
    });
    expect(response.body.accessToken).toEqual(expect.any(String));
  });

  it('issues the same refresh cookie the password routes issue', async () => {
    stubGoogle(verified());

    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(201);

    // Express sends one Set-Cookie header; supertest types it as string|string[].
    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookie = cookies.find((c) => c?.startsWith(`${REFRESH_COOKIE_NAME}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite');
  });

  it('produces a session the protected routes accept', async () => {
    stubGoogle(verified());
    const session = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(201);

    // The whole point of issuing the *same* pair: nothing downstream needs to
    // know this session came from Google.
    const me = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${session.body.accessToken}` })
      .expect(200);
    expect(me.body.user.email).toBe('google-new@fintrack.test');

    await request(app)
      .get('/api/accounts')
      .set({ Authorization: `Bearer ${session.body.accessToken}` })
      .expect(200);
  });

  it('lands a password user on their original account, not a duplicate', async () => {
    const original = await prisma.user.create({
      data: {
        email: 'google-linked@fintrack.test',
        passwordHash: await hashPassword(PASSWORD),
        name: 'Grace Hopper',
      },
      select: { id: true },
    });

    stubGoogle(verified({ sub: 'google-sub-0002', email: 'google-linked@fintrack.test' }));

    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      // 200, not 201: nothing was created.
      .expect(200);

    expect(response.body).toMatchObject({ isNewUser: false, resolution: 'linked' });
    expect(response.body.user.id).toBe(original.id);
    expect(await prisma.user.count({ where: { email: 'google-linked@fintrack.test' } })).toBe(1);
  });

  it('refuses an unverified Google email rather than linking on it', async () => {
    // The security of the linking path rests on this. Without it, anyone able
    // to make a Google account claiming somebody else's address could walk
    // into that person's FinTrack account.
    await prisma.user.create({
      data: {
        email: 'google-linked@fintrack.test',
        passwordHash: await hashPassword(PASSWORD),
      },
    });

    stubGoogle(
      verified({
        sub: 'attacker-sub',
        email: 'google-linked@fintrack.test',
        email_verified: false,
      }),
    );

    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(401);

    expect(response.body.error).toMatch(/not verified/i);
    const row = await prisma.user.findUniqueOrThrow({
      where: { email: 'google-linked@fintrack.test' },
      select: { googleId: true },
    });
    expect(row.googleId).toBeNull();
  });

  it('refuses a token Google will not verify', async () => {
    setGoogleOAuthClient({
      verifyIdToken: vi.fn(async () => {
        throw new Error('Invalid token signature');
      }),
    } as never);

    await request(app).post('/api/auth/google').send({ credential: 'forged' }).expect(401);
    expect(await prisma.user.count({ where: { email: { in: EMAILS } } })).toBe(0);
  });

  it('rejects a request with no credential', async () => {
    await request(app).post('/api/auth/google').send({}).expect(400);
  });

  it('refuses a password login against a Google-only account', async () => {
    stubGoogle(verified());
    await request(app).post('/api/auth/google').send({ credential: 'an-id-token' }).expect(201);

    // No password was ever set, so there is nothing to compare against — and
    // the answer must be the ordinary 401, not a hint that the account exists.
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'google-new@fintrack.test', password: PASSWORD })
      .expect(401);
    expect(response.body.error).toBe('Incorrect email or password');
  });

  it('says the deployment is misconfigured rather than blaming the visitor', async () => {
    delete process.env.GOOGLE_CLIENT_ID;

    const response = await request(app)
      .post('/api/auth/google')
      .send({ credential: 'an-id-token' })
      .expect(500);
    expect(response.body.error).toMatch(/not configured/i);
  });
});
