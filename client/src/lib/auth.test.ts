import MockAdapter from 'axios-mock-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authApi, login, refreshSession, register } from '@/lib/auth';

// lib/auth deliberately uses its own axios instance, without the interceptors:
// the auth calls are what the interceptors use to recover from a 401, so
// routing them through the same client would let a failed refresh trigger
// another refresh.
let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(authApi);
});

afterEach(() => {
  mock.restore();
});

const SESSION = {
  accessToken: 'token-1',
  expiresIn: 900,
  user: { id: 'user_1', email: 'alice@example.test', name: 'Alice' },
};

describe('refreshSession', () => {
  it('exchanges the cookie for a session', async () => {
    mock.onPost('/api/auth/refresh').reply(200, SESSION);
    await expect(refreshSession()).resolves.toEqual(SESSION);
  });

  it('makes one request for concurrent callers, never two', async () => {
    // The regression this guards: every refresh rotates the token, and the
    // server treats a spent token coming back as stolen — it ends every
    // session. React StrictMode invokes mount effects twice, so the session
    // restore fired twice and signed the user out on every reload.
    let requests = 0;
    mock.onPost('/api/auth/refresh').reply(() => {
      requests += 1;
      return new Promise((resolve) => setTimeout(() => resolve([200, SESSION]), 20));
    });

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(requests).toBe(1);
    expect(first).toEqual(second);
  });

  it('starts a new request once the previous one has settled', async () => {
    let requests = 0;
    mock.onPost('/api/auth/refresh').reply(() => {
      requests += 1;
      return [200, SESSION];
    });

    await refreshSession();
    await refreshSession();

    expect(requests).toBe(2);
  });

  it('does not leave a rejected attempt cached', async () => {
    mock.onPost('/api/auth/refresh').replyOnce(401, { error: 'No refresh token' });
    await expect(refreshSession()).rejects.toBeTruthy();

    mock.onPost('/api/auth/refresh').reply(200, SESSION);
    await expect(refreshSession()).resolves.toEqual(SESSION);
  });
});

describe('login and register', () => {
  it('sends credentials and returns the session', async () => {
    mock.onPost('/api/auth/login').reply(200, SESSION);
    await expect(login({ email: 'alice@example.test', password: 'x' })).resolves.toEqual(SESSION);
  });

  it('registers and returns the session', async () => {
    mock.onPost('/api/auth/register').reply(201, SESSION);
    await expect(
      register({ email: 'alice@example.test', password: 'x', name: 'Alice' }),
    ).resolves.toEqual(SESSION);
  });

  it('sends cookies, so the refresh token is set and returned', async () => {
    mock
      .onPost('/api/auth/login')
      .reply((config) => [200, { withCredentials: config.withCredentials }]);
    const result = (await login({ email: 'a@b.test', password: 'x' })) as unknown as {
      withCredentials: boolean;
    };
    expect(result.withCredentials).toBe(true);
  });
});
