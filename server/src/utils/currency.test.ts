import { describe, expect, it } from 'vitest';

import { formatINR, formatINRCompact } from './currency';

/**
 * The same table runs against the client's copy in
 * `client/src/lib/currency.test.ts`. If the two ever disagree, an anomaly
 * explanation written by the server will not match what the dashboard renders
 * beside it, so keep both lists in step.
 */
describe('formatINR', () => {
  it('formats zero without a sign', () => {
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(-0)).toBe('₹0.00');
    // An amount that rounds away to nothing is not "-₹0.00".
    expect(formatINR(-0.004)).toBe('₹0.00');
    expect(formatINR(0, { showSign: true })).toBe('₹0.00');
  });

  it('formats a debit as a negative amount', () => {
    expect(formatINR(-1234.5)).toBe('-₹1,234.50');
    expect(formatINR(-99)).toBe('-₹99.00');
    // The minus goes outside the symbol, not between it and the digits.
    expect(formatINR(-1234.5)).not.toContain('₹-');
  });

  it('formats a value under a thousand with no grouping at all', () => {
    expect(formatINR(0.5)).toBe('₹0.50');
    expect(formatINR(99.99)).toBe('₹99.99');
    expect(formatINR(999)).toBe('₹999.00');
  });

  it('groups the first three digits, then twos', () => {
    expect(formatINR(1000)).toBe('₹1,000.00');
    expect(formatINR(45000)).toBe('₹45,000.00');
    // The example from the brief.
    expect(formatINR(1234567.89)).toBe('₹12,34,567.89');
  });

  it('formats lakhs', () => {
    expect(formatINR(100000)).toBe('₹1,00,000.00');
    expect(formatINR(150000)).toBe('₹1,50,000.00');
    expect(formatINR(999999.99)).toBe('₹9,99,999.99');
  });

  it('formats crores', () => {
    expect(formatINR(10000000)).toBe('₹1,00,00,000.00');
    expect(formatINR(12345678.9)).toBe('₹1,23,45,678.90');
    expect(formatINR(123456789)).toBe('₹12,34,56,789.00');
    expect(formatINR(-12345678.9)).toBe('-₹1,23,45,678.90');
  });

  it('shows a plus only when asked, and only for positives', () => {
    expect(formatINR(1234.5, { showSign: true })).toBe('+₹1,234.50');
    expect(formatINR(-1234.5, { showSign: true })).toBe('-₹1,234.50');
    expect(formatINR(1234.5)).toBe('₹1,234.50');
  });

  it('always shows paise, so a column of amounts lines up', () => {
    expect(formatINR(2500)).toBe('₹2,500.00');
    expect(formatINR(2500.5)).toBe('₹2,500.50');
    expect(formatINR(2500.567)).toBe('₹2,500.57');
  });

  it('does not produce NaN for a value that is not a number', () => {
    expect(formatINR(Number.NaN)).toBe('₹0.00');
    expect(formatINR(Number.POSITIVE_INFINITY)).toBe('₹0.00');
  });
});

describe('formatINRCompact', () => {
  it('drops the paise but keeps the grouping', () => {
    expect(formatINRCompact(1234567.89)).toBe('₹12,34,568');
    expect(formatINRCompact(45000)).toBe('₹45,000');
    expect(formatINRCompact(999)).toBe('₹999');
    expect(formatINRCompact(0)).toBe('₹0');
    expect(formatINRCompact(-45000)).toBe('-₹45,000');
    expect(formatINRCompact(-0.4)).toBe('₹0');
  });
});

describe('the client copy', () => {
  it('is byte-identical to this one, apart from the cross-reference comment', async () => {
    // The brief allows duplicating the function rather than extracting a
    // package, on the condition that the logic stays identical. Nothing but a
    // test enforces that, so this is the test.
    const { readFile } = await import('node:fs/promises');
    const strip = (source: string) =>
      source
        .split('\n')
        .filter((line) => !line.includes('duplicated verbatim'))
        .filter((line) => !line.includes('currency.test.ts`'))
        .filter((line) => !/^ \* `(client|server)\//.test(line))
        .join('\n');

    // Paths from the workspace root: the server compiles to CommonJS, where
    // `import.meta` is not available.
    const here = await readFile('src/utils/currency.ts', 'utf8');
    const there = await readFile('../client/src/lib/currency.ts', 'utf8');

    expect(strip(there)).toBe(strip(here));
  });
});
