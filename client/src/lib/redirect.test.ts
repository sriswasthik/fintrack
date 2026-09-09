import { describe, expect, it } from 'vitest';

import { DEFAULT_DESTINATION, safeRedirect } from '@/lib/redirect';

/** Build a string containing a control character without typing one. */
const withControl = (code: number) => `/${String.fromCharCode(code)}/evil.test`;

describe('safeRedirect', () => {
  it('keeps a path inside the app, query string and all', () => {
    expect(safeRedirect('/summary')).toBe('/summary');
    expect(safeRedirect('/transactions?accountId=acct_1&page=2')).toBe(
      '/transactions?accountId=acct_1&page=2',
    );
  });

  it('falls back when there is nothing usable to go on', () => {
    expect(safeRedirect(undefined)).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect(null)).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect({ pathname: '/summary' })).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect(42)).toBe(DEFAULT_DESTINATION);
  });

  it('refuses an absolute URL, however it is dressed up', () => {
    expect(safeRedirect('https://evil.test/steal')).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect('javascript:alert(1)')).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect('evil.test')).toBe(DEFAULT_DESTINATION);
  });

  it('refuses a protocol-relative destination', () => {
    // The advisory this guards against: react-router 6 follows both of these
    // off-origin from a <Link> or navigate() (GHSA-wrjc-x8rr-h8h6).
    expect(safeRedirect('//evil.test')).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect('/\\evil.test')).toBe(DEFAULT_DESTINATION);
    expect(safeRedirect('/\\\\evil.test')).toBe(DEFAULT_DESTINATION);
  });

  it('refuses a backslash anywhere in the path', () => {
    expect(safeRedirect('/summary\\@evil.test')).toBe(DEFAULT_DESTINATION);
  });

  it('refuses control characters, which a browser strips before parsing', () => {
    expect(safeRedirect(withControl(9))).toBe(DEFAULT_DESTINATION); // tab
    expect(safeRedirect(withControl(10))).toBe(DEFAULT_DESTINATION); // newline
    expect(safeRedirect(withControl(13))).toBe(DEFAULT_DESTINATION); // carriage return
    expect(safeRedirect(withControl(0))).toBe(DEFAULT_DESTINATION); // NUL
    expect(safeRedirect(withControl(127))).toBe(DEFAULT_DESTINATION); // DEL
  });
});
