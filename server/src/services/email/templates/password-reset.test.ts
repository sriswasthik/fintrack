import { describe, expect, it } from 'vitest';

import { renderPasswordResetEmail } from './password-reset';

const URL = 'https://fintrack.example/reset-password?token=abc_DEF-123';

describe('renderPasswordResetEmail', () => {
  const email = renderPasswordResetEmail({ name: 'Priya Sharma', resetUrl: URL, ttlMinutes: 60 });

  it('has a plain, specific subject with no ALL-CAPS run', () => {
    expect(email.subject).toBe('Reset your FinTrack password');
    expect(email.subject).not.toMatch(/[A-Z]{4,}/);
  });

  it('puts the link in both parts', () => {
    expect(email.html).toContain(`href="${URL}"`);
    expect(email.text).toContain(URL);
  });

  it('says how long the link lasts, and that ignoring it is safe', () => {
    // Whitespace collapsed: the text part is wrapped at 72 columns, which can
    // put a line break inside a phrase.
    for (const part of [email.html, email.text].map((p) => p.replace(/\s+/g, ' '))) {
      expect(part).toMatch(/1 hour/);
      expect(part).toMatch(/ignore this email/);
    }
  });

  it('greets by first name, and escapes it', () => {
    expect(email.text.startsWith('Hi Priya,')).toBe(true);
    const hostile = renderPasswordResetEmail({
      name: '<img src=x onerror=alert(1)>',
      resetUrl: URL,
      ttlMinutes: 60,
    });
    expect(hostile.html).not.toContain('<img src=x');
    expect(hostile.html).toContain('&lt;img');
  });

  it('greets nobody in particular without a name', () => {
    const anonymous = renderPasswordResetEmail({ resetUrl: URL, ttlMinutes: 30 });
    expect(anonymous.text.startsWith('Hi,')).toBe(true);
    expect(anonymous.text.replace(/\s+/g, ' ')).toMatch(/30 minutes/);
  });

  it('keeps the plain-text part within a mail-client width', () => {
    for (const line of email.text.split('\n')) {
      if (line === URL) continue;
      expect(line.length).toBeLessThanOrEqual(72);
    }
  });
});
