/**
 * The rate limiters key a signed-out request by `req.ip`, so what Express
 * believes about the client's address decides whether one person's failed
 * sign-ins throttle everybody behind the platform's load balancer.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp, trustProxySetting } from './app';

describe('trustProxySetting', () => {
  it('trusts exactly one hop in production when nothing says otherwise', () => {
    expect(trustProxySetting({ NODE_ENV: 'production' })).toBe(1);
  });

  it('trusts nothing outside production by default', () => {
    expect(trustProxySetting({ NODE_ENV: 'development' })).toBe(false);
    expect(trustProxySetting({})).toBe(false);
  });

  it('takes a hop count', () => {
    expect(trustProxySetting({ TRUST_PROXY: '2', NODE_ENV: 'production' })).toBe(2);
    expect(trustProxySetting({ TRUST_PROXY: '0' })).toBe(0);
  });

  it('can be turned off in production for a server with no proxy in front', () => {
    expect(trustProxySetting({ TRUST_PROXY: 'false', NODE_ENV: 'production' })).toBe(false);
    expect(trustProxySetting({ TRUST_PROXY: 'off', NODE_ENV: 'production' })).toBe(false);
  });

  it('passes anything else through for Express to interpret', () => {
    expect(trustProxySetting({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })).toBe('loopback, 10.0.0.0/8');
    expect(trustProxySetting({ TRUST_PROXY: 'true' })).toBe(true);
  });
});

describe('what the setting does to req.ip', () => {
  // A bare app with the same setting and a route that reports what Express
  // decided, because the real app has no route that echoes an address.
  const echo = (setting: boolean | number | string) => {
    const app = express();
    app.set('trust proxy', setting);
    app.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  };

  it('with one hop, sees the client the balancer names rather than the balancer', async () => {
    const res = await request(echo(1)).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('with one hop, ignores an address the client wrote in itself', async () => {
    // The balancer appends the real address; anything to its left came from
    // the caller and must not become the rate-limit key.
    const res = await request(echo(1))
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.7');
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('with it off, sees only the socket', async () => {
    const res = await request(echo(false)).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.ip).not.toBe('203.0.113.7');
  });

  it('is applied to the real app', () => {
    expect(createApp().get('trust proxy')).toBe(trustProxySetting());
  });
});
