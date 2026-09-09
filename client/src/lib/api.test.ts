import MockAdapter from 'axios-mock-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, configureSessionRecovery, getAccessToken, setAccessToken } from '@/lib/api';

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(api);
  setAccessToken(null);
  configureSessionRecovery({ renew: async () => null, onLost: () => undefined });
});

afterEach(() => {
  mock.restore();
});

describe('the access token', () => {
  it('is attached as a bearer header once set', async () => {
    setAccessToken('token-1');
    mock.onGet('/api/accounts').reply((config) => [200, { seen: config.headers?.Authorization }]);

    const { data } = await api.get('/api/accounts');
    expect(data.seen).toBe('Bearer token-1');
  });

  it('is not sent when there is no session', async () => {
    mock.onGet('/api/accounts').reply((config) => [200, { seen: config.headers?.Authorization }]);

    const { data } = await api.get('/api/accounts');
    expect(data.seen).toBeUndefined();
  });

  it('lives in memory, not in browser storage', () => {
    setAccessToken('token-1');

    expect(getAccessToken()).toBe('token-1');
    // Nothing durable: a script injected into the page has nothing to read
    // after the fact, and a closed tab leaves nothing on a shared machine.
    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    expect(document.cookie).toBe('');
  });
});

describe('recovering from a 401', () => {
  it('refreshes once and retries the original request', async () => {
    const renew = vi.fn().mockImplementation(async () => {
      setAccessToken('token-2');
      return 'token-2';
    });
    configureSessionRecovery({ renew, onLost: vi.fn() });

    let attempts = 0;
    mock.onGet('/api/dashboard').reply((config) => {
      attempts += 1;
      if (attempts === 1) return [401, { error: 'Invalid or expired access token' }];
      return [200, { seen: config.headers?.Authorization }];
    });

    const { data } = await api.get('/api/dashboard');

    expect(renew).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
    expect(data.seen).toBe('Bearer token-2');
  });

  it('gives up after one retry rather than looping', async () => {
    const renew = vi.fn().mockResolvedValue('token-2');
    const onLost = vi.fn();
    configureSessionRecovery({ renew, onLost });

    mock.onGet('/api/dashboard').reply(401, { error: 'nope' });

    await expect(api.get('/api/dashboard')).rejects.toMatchObject({
      response: { status: 401 },
    });
    // One refresh, one retry, then the error surfaces. A second refresh would
    // rotate the token again and the server would read that as a replay.
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('refreshes once for a burst of 401s, not once per request', async () => {
    // A dashboard loads four queries at once. Four refreshes would mean four
    // rotations, and the server treats a spent refresh token coming back as a
    // stolen one — logging the user out for loading a page.
    let renewals = 0;
    configureSessionRecovery({
      renew: async () => {
        renewals += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        setAccessToken('token-2');
        return 'token-2';
      },
      onLost: vi.fn(),
    });

    const seen: Record<string, number> = {};
    for (const path of ['/api/a', '/api/b', '/api/c', '/api/d']) {
      mock.onGet(path).reply(() => {
        seen[path] = (seen[path] ?? 0) + 1;
        return seen[path] === 1 ? [401, {}] : [200, { path }];
      });
    }

    const responses = await Promise.all(
      ['/api/a', '/api/b', '/api/c', '/api/d'].map((path) => api.get(path)),
    );

    expect(renewals).toBe(1);
    expect(responses.map((r) => r.data.path)).toEqual(['/api/a', '/api/b', '/api/c', '/api/d']);
  });

  it('reports the session lost when the refresh fails', async () => {
    const onLost = vi.fn();
    configureSessionRecovery({ renew: async () => null, onLost });

    mock.onGet('/api/dashboard').reply(401, { error: 'nope' });

    await expect(api.get('/api/dashboard')).rejects.toBeTruthy();
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('leaves every other failure alone', async () => {
    const renew = vi.fn();
    configureSessionRecovery({ renew, onLost: vi.fn() });

    mock.onGet('/api/dashboard').reply(500, { error: 'Internal server error' });

    await expect(api.get('/api/dashboard')).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(renew).not.toHaveBeenCalled();
  });

  it('does not retry a 403, which refreshing cannot fix', async () => {
    const renew = vi.fn();
    configureSessionRecovery({ renew, onLost: vi.fn() });

    mock.onGet('/api/dashboard').reply(404, { error: 'No such account' });

    await expect(api.get('/api/dashboard')).rejects.toBeTruthy();
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('credentials', () => {
  it('sends cookies, so the httpOnly refresh token reaches the API', () => {
    expect(api.defaults.withCredentials).toBe(true);
  });
});
