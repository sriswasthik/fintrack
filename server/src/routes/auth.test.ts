import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The database is mocked so this runs in CI without Postgres. What is tested
// here is the protocol: what goes in the body, what goes in the cookie, what is
// stored, and what a failure reveals. The same flow is exercised against a real
// database and two real accounts in the Phase 9 verification harness.
const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  refreshCreate: vi.fn(),
  refreshFindUnique: vi.fn(),
  refreshUpdate: vi.fn(),
  refreshUpdateMany: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../db', () => ({ getPrisma: () => prismaMock }));

import { app } from '../app';
import { hashPassword } from '../services/auth/passwords';
import {
  hashToken,
  issueRefreshToken,
  REFRESH_COOKIE_NAME,
  signAccessToken,
} from '../services/auth/tokens';

const PASSWORD = 'correct-horse-battery';
let passwordHash: string;

const USER = { id: 'user_1', email: 'alice@example.test', name: 'Alice' };

beforeEach(async () => {
  vi.clearAllMocks();
  passwordHash ??= await hashPassword(PASSWORD);

  db.userFindUnique.mockResolvedValue(null);
  db.userCreate.mockResolvedValue(USER);
  db.refreshCreate.mockResolvedValue({ id: 'rt_1' });
  db.refreshFindUnique.mockResolvedValue(null);
  db.refreshUpdate.mockResolvedValue({});
  db.refreshUpdateMany.mockResolvedValue({ count: 0 });

  Object.assign(prismaMock, {
    user: { findUnique: db.userFindUnique, create: db.userCreate },
    refreshToken: {
      create: db.refreshCreate,
      findUnique: db.refreshFindUnique,
      update: db.refreshUpdate,
      updateMany: db.refreshUpdateMany,
    },
    $transaction: (operations: unknown) => Promise.all(operations as unknown[]),
  });
});

/** The Set-Cookie value for the refresh token, if the response set one. */
function refreshCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

const cookieValue = (cookie: string) => cookie.split(';')[0].split('=').slice(1).join('=');

describe('POST /api/auth/register', () => {
  it('creates the user and starts a session', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.test', password: PASSWORD, name: 'Alice' })
      .expect(201);

    expect(response.body.user).toEqual(USER);
    expect(response.body.accessToken).toBeTruthy();
    expect(refreshCookie(response)).toBeTruthy();
  });

  it('stores a bcrypt hash and never the password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(201);

    const { data } = db.userCreate.mock.calls[0][0];
    expect(data.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(JSON.stringify(data)).not.toContain(PASSWORD);
  });

  it('stores only a hash of the refresh token', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(201);

    const token = cookieValue(refreshCookie(response)!);
    const { data } = db.refreshCreate.mock.calls[0][0];
    expect(data.tokenHash).toBe(hashToken(token));
    expect(data.tokenHash).not.toBe(token);
  });

  it('lowercases and trims the address, so one person cannot register twice', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: '  Alice@Example.TEST ', password: PASSWORD })
      .expect(201);

    expect(db.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'alice@example.test' } }),
    );
  });

  it('refuses a password short enough to guess', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.test', password: 'short' })
      .expect(400);
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it('refuses something that is not an email address', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-address', password: PASSWORD })
      .expect(400);
  });

  it('does not confirm which addresses already have accounts', async () => {
    db.userFindUnique.mockResolvedValue({ id: 'user_existing' });

    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(409);

    expect(response.body.error).not.toMatch(/already|exists|registered.*alice/i);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    db.userFindUnique.mockResolvedValue({ ...USER, passwordHash });
  });

  it('returns an access token in the body and a refresh token in a cookie', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(200);

    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.user).toEqual(USER);
    // The refresh token must not be in the body, where script could read it.
    expect(JSON.stringify(response.body)).not.toContain(cookieValue(refreshCookie(response)!));
  });

  it('marks the refresh cookie httpOnly and scopes it to the auth routes', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.test', password: PASSWORD })
      .expect(200);

    const cookie = refreshCookie(response)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/i);
  });

  it('rejects the wrong password', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.test', password: 'not-the-password' })
      .expect(401);
  });

  it('answers an unknown address exactly as it answers a wrong password', async () => {
    db.userFindUnique.mockResolvedValue(null);
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: PASSWORD })
      .expect(401);

    db.userFindUnique.mockResolvedValue({ ...USER, passwordHash });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.test', password: 'not-the-password' })
      .expect(401);

    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('POST /api/auth/refresh', () => {
  function stored(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt_1',
      userId: USER.id,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      ...overrides,
    };
  }

  it('rotates the token and issues a new access token', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(stored());
    db.userFindUnique.mockResolvedValue(USER);

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(200);

    expect(response.body.accessToken).toBeTruthy();
    // The presented token is revoked and a different one takes its place.
    expect(db.refreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rt_1' } }),
    );
    const replacement = cookieValue(refreshCookie(response)!);
    expect(replacement).not.toBe(issued.token);
  });

  it('looks the token up by its hash, not its value', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(stored());
    db.userFindUnique.mockResolvedValue(USER);

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(200);

    expect(db.refreshFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashToken(issued.token) } }),
    );
  });

  it('refuses a request with no refresh token at all', async () => {
    await request(app).post('/api/auth/refresh').expect(401);
  });

  it('refuses a token that was never issued', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(null);

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(401);
  });

  it('refuses a token belonging to a different user than it claims', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(stored({ userId: 'user_2' }));

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(401);
  });

  it('treats a replayed token as a compromise and ends every session', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(stored({ revokedAt: new Date() }));

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(401);

    // Not just this token: every unrevoked token the user has. A token that
    // was already spent coming back means it was replayed or stolen, and there
    // is no way to tell which.
    expect(db.refreshUpdateMany).toHaveBeenCalledWith({
      where: { userId: USER.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('refuses an expired token', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(stored({ expiresAt: new Date(Date.now() - 1000) }));

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(401);
  });

  it('accepts the token in the body, for a client with no cookie jar', async () => {
    const issued = issueRefreshToken(USER.id);
    db.refreshFindUnique.mockResolvedValue(stored());
    db.userFindUnique.mockResolvedValue(USER);

    await request(app).post('/api/auth/refresh').send({ refreshToken: issued.token }).expect(200);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the presented token and clears the cookie', async () => {
    const issued = issueRefreshToken(USER.id);

    const response = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${issued.token}`)
      .expect(204);

    expect(db.refreshUpdateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(issued.token), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(refreshCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('is idempotent — signing out twice is still signed out', async () => {
    await request(app).post('/api/auth/logout').expect(204);
    expect(db.refreshUpdateMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/me', () => {
  it('describes the bearer of the token', async () => {
    db.userFindUnique.mockResolvedValue({ ...USER, createdAt: new Date('2026-09-01') });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${signAccessToken(USER.id)}`)
      .expect(200);

    expect(response.body.user).toMatchObject({ id: USER.id, email: USER.email });
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(db.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER.id } }),
    );
  });

  it('401s without a token', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  it('401s for a user that no longer exists', async () => {
    db.userFindUnique.mockResolvedValue(null);
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${signAccessToken('user_deleted')}`)
      .expect(401);
  });
});
