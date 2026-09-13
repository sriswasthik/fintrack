import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthConfigurationError } from './tokens';
import {
  googleClientId,
  googleSignInEnabled,
  InvalidGoogleTokenError,
  setGoogleOAuthClient,
  verifyGoogleIdToken,
} from './google';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

/** A payload shaped like the one Google returns, overridable per case. */
const payload = (over: Record<string, unknown> = {}) => ({
  sub: '1174829301827364',
  email: 'ada@example.test',
  email_verified: true,
  name: 'Ada Lovelace',
  picture: 'https://lh3.googleusercontent.com/a/ada',
  ...over,
});

function stub(result: Record<string, unknown> | null | undefined) {
  const verifyIdToken = vi.fn(async () => ({ getPayload: () => result ?? undefined }));
  setGoogleOAuthClient({ verifyIdToken } as never);
  return verifyIdToken;
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
});

afterEach(() => {
  setGoogleOAuthClient(null);
  vi.restoreAllMocks();
});

describe('googleClientId', () => {
  it('reads the configured client id', () => {
    expect(googleClientId()).toBe(CLIENT_ID);
  });

  it('says what to set when it is missing', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    // Distinct from an invalid token on purpose: one is a broken deployment
    // that will fail for everybody, the other is one visitor sending rubbish.
    expect(() => googleClientId()).toThrow(AuthConfigurationError);
    expect(() => googleClientId()).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe('googleSignInEnabled', () => {
  it('is on when a client id is configured and off when it is not', () => {
    expect(googleSignInEnabled()).toBe(true);
    delete process.env.GOOGLE_CLIENT_ID;
    expect(googleSignInEnabled()).toBe(false);
  });
});

describe('verifyGoogleIdToken', () => {
  it('pins the audience to our own client id', async () => {
    // Without this, an ID token minted for any other Google app would verify
    // here — the signature and issuer are genuine, the intended recipient is
    // somebody else, and the result is an account takeover.
    const verifyIdToken = stub(payload());

    await verifyGoogleIdToken('an-id-token');

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'an-id-token',
      audience: CLIENT_ID,
    });
  });

  it('returns the identity out of the verified payload', async () => {
    stub(payload());

    await expect(verifyGoogleIdToken('an-id-token')).resolves.toEqual({
      googleId: '1174829301827364',
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.com/a/ada',
    });
  });

  it('lower-cases and trims the email so matching is not case-sensitive', async () => {
    // `Ada@Example.test` and `ada@example.test` are one address, and the
    // account-linking lookup is an exact match on a stored lower-cased string.
    stub(payload({ email: '  Ada@Example.TEST  ' }));

    await expect(verifyGoogleIdToken('an-id-token')).resolves.toMatchObject({
      email: 'ada@example.test',
    });
  });

  it('treats a blank name or picture as absent', async () => {
    stub(payload({ name: '   ', picture: '' }));

    await expect(verifyGoogleIdToken('an-id-token')).resolves.toMatchObject({
      name: null,
      picture: null,
    });
  });

  it('refuses a token whose email Google has not verified', async () => {
    stub(payload({ email_verified: false }));

    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(InvalidGoogleTokenError);
    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(/not verified/i);
  });

  it.each([
    ['missing', undefined],
    ['explicitly false', false],
    ['the string "true"', 'true'],
    ['a truthy number', 1],
  ])('refuses when email_verified is %s', async (_label, value) => {
    // Only an exact `true` counts. A loose check would accept the string
    // "false", which is truthy.
    stub(payload({ email_verified: value }));
    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(InvalidGoogleTokenError);
  });

  it('refuses a payload with no subject', async () => {
    stub(payload({ sub: undefined }));
    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(InvalidGoogleTokenError);
  });

  it('refuses a payload with no email', async () => {
    stub(payload({ email: undefined }));
    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(/no email address/i);
  });

  it('refuses when the verifier returns nothing at all', async () => {
    stub(null);
    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(InvalidGoogleTokenError);
  });

  it('gives one answer for every way verification can fail', async () => {
    // Bad signature, expired, wrong audience: which check failed is useful to
    // somebody probing the endpoint and useless to an honest client.
    setGoogleOAuthClient({
      verifyIdToken: vi.fn(async () => {
        throw new Error('Token used too late, 1789-07-14');
      }),
    } as never);

    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(
      'That Google sign-in could not be verified',
    );
  });

  it('lets a misconfiguration through rather than calling it a bad token', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    stub(payload());

    await expect(verifyGoogleIdToken('an-id-token')).rejects.toThrow(AuthConfigurationError);
  });
});
