import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appUrl, emailConfigured, sendEmail, sendInBackground, setEmailClient } from './send';

const MESSAGE = {
  to: 'ada@example.test',
  subject: 'Welcome to FinTrack',
  html: '<p>hello</p>',
  text: 'hello',
};

/** Stands in for the Resend SDK. */
function stub(result: {
  data?: { id: string } | null;
  error?: { name: string; message: string } | null;
}) {
  const send = vi.fn().mockResolvedValue(result);
  setEmailClient({ emails: { send } } as never);
  return send;
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'FinTrack <hello@fintrack.test>';
  delete process.env.APP_URL;
});

afterEach(() => {
  setEmailClient(null);
  vi.restoreAllMocks();
});

describe('emailConfigured', () => {
  it('needs both the key and the from address', () => {
    expect(emailConfigured()).toBe(true);

    delete process.env.RESEND_API_KEY;
    expect(emailConfigured()).toBe(false);

    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.EMAIL_FROM;
    expect(emailConfigured()).toBe(false);
  });
});

describe('appUrl', () => {
  it('prefers APP_URL, falls back to CORS_ORIGIN, then to localhost', () => {
    process.env.CORS_ORIGIN = 'https://cors.test';
    process.env.APP_URL = 'https://app.test';
    expect(appUrl()).toBe('https://app.test');

    // A working deployment has already set CORS_ORIGIN to the client's URL, so
    // a correct link costs no second variable.
    delete process.env.APP_URL;
    expect(appUrl()).toBe('https://cors.test');

    delete process.env.CORS_ORIGIN;
    expect(appUrl()).toBe('http://localhost:5173');
  });
});

describe('sendEmail', () => {
  it('sends the html and the text together', async () => {
    const send = stub({ data: { id: 'msg_123' }, error: null });

    await expect(sendEmail(MESSAGE)).resolves.toEqual({ sent: true, id: 'msg_123' });

    // Both parts, every time: a message with no text part is itself a spam
    // signal, and a text-only client would otherwise get nothing.
    expect(send).toHaveBeenCalledWith({
      from: 'FinTrack <hello@fintrack.test>',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
  });

  it('skips, and says why, when the deployment cannot send mail', async () => {
    delete process.env.RESEND_API_KEY;
    const send = stub({ data: { id: 'msg_123' }, error: null });

    await expect(sendEmail(MESSAGE)).resolves.toMatchObject({
      sent: false,
      reason: expect.stringContaining('RESEND_API_KEY'),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a refusal the SDK returns rather than throws', async () => {
    // An invalid API key comes back in `error`, not as an exception.
    stub({ data: null, error: { name: 'validation_error', message: 'API key is invalid' } });

    await expect(sendEmail(MESSAGE)).resolves.toEqual({
      sent: false,
      reason: 'validation_error: API key is invalid',
    });
  });

  it('never throws, whatever the transport does', async () => {
    setEmailClient({
      emails: {
        send: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.resend.com')),
      },
    } as never);

    await expect(sendEmail(MESSAGE)).resolves.toMatchObject({
      sent: false,
      reason: 'getaddrinfo ENOTFOUND api.resend.com',
    });
  });

  it('survives a rejection that is not an Error', async () => {
    setEmailClient({ emails: { send: vi.fn().mockRejectedValue('nope') } } as never);

    await expect(sendEmail(MESSAGE)).resolves.toMatchObject({
      sent: false,
      reason: 'Unknown error',
    });
  });
});

describe('sendInBackground', () => {
  it('returns before the send settles', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    setEmailClient({
      emails: { send: vi.fn(() => pending.then(() => ({ data: { id: 'x' }, error: null }))) },
    } as never);

    // The whole point: a slow provider must not hold a registration open.
    expect(sendInBackground(MESSAGE, 'welcome')).toBeUndefined();
    release();
    await pending;
  });

  it('logs a failure server-side and swallows it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stub({ data: null, error: { name: 'validation_error', message: 'API key is invalid' } });

    sendInBackground(MESSAGE, 'welcome');
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    expect(error.mock.calls[0][0]).toContain('welcome');
    expect(error.mock.calls[0][0]).toContain('ada@example.test');
    expect(error.mock.calls[0][0]).toContain('API key is invalid');
  });

  it('says nothing on success', async () => {
    // The repo logs at warn and error only, and a courtesy email arriving is
    // not news.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = stub({ data: { id: 'msg_123' }, error: null });

    sendInBackground(MESSAGE, 'welcome');
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('cannot produce an unhandled rejection', async () => {
    // An unhandled rejection is fatal in Node by default. A courtesy email must
    // never be able to take the server down.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    setEmailClient({ emails: { send: vi.fn().mockRejectedValue(new Error('boom')) } } as never);
    sendInBackground(MESSAGE, 'welcome');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});
