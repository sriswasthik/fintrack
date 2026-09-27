import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  extractPdfText,
  IncorrectPasswordError,
  inspectPdf,
  PasswordRequiredError,
  UnreadablePdfError,
} from './pdf';

// The first test in this file to open a PDF pays for loading pdf.js: about a
// second on its own, and past Vitest's 5s default when every suite runs at once.
vi.setConfig({ testTimeout: 20_000 });

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test-data');
const plain = () => readFileSync(join(FIXTURES, 'statement_plain.pdf'));
const encrypted = () => readFileSync(join(FIXTURES, 'statement_encrypted.pdf'));

/** Committed alongside the fixture; it opens nothing else. */
const PASSWORD = 'fintrack-test-password';

describe('inspectPdf', () => {
  it('says a plain statement needs no password', async () => {
    await expect(inspectPdf(plain())).resolves.toEqual({ requiresPassword: false });
  });

  it('says an encrypted statement does', async () => {
    await expect(inspectPdf(encrypted())).resolves.toEqual({ requiresPassword: true });
  });

  it('does not need a password itself to answer', async () => {
    // The whole point: this is the call the client makes before it has any
    // password to offer, and before it decides whether to ask for one.
    await expect(inspectPdf(encrypted())).resolves.toEqual({ requiresPassword: true });
  });

  it('refuses something that is not a PDF', async () => {
    await expect(inspectPdf(Buffer.from('this is not a pdf'))).rejects.toBeInstanceOf(
      UnreadablePdfError,
    );
  });
});

describe('extractPdfText', () => {
  it('returns text with the coordinates it was drawn at', async () => {
    const pages = await extractPdfText(plain());

    expect(pages.length).toBeGreaterThan(0);
    const [first] = pages;
    expect(first.pageNumber).toBe(1);
    expect(first.items.length).toBeGreaterThan(50);

    for (const item of first.items) {
      expect(item.text).not.toBe('');
      expect(Number.isFinite(item.x)).toBe(true);
      expect(Number.isFinite(item.y)).toBe(true);
      expect(item.width).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads the column headings the reference layout expects', async () => {
    const [page] = await extractPdfText(plain());
    const text = page.items.map((i) => i.text);

    for (const heading of ['Date', 'Narration', 'Reference No', 'Debit', 'Credit', 'Balance']) {
      expect(text).toContain(heading);
    }
  });

  it('distinguishes a missing password from a wrong one', async () => {
    // These send a person to different next actions — type one, versus try a
    // different one — so they must not collapse into a single error.
    await expect(extractPdfText(encrypted())).rejects.toBeInstanceOf(PasswordRequiredError);
    await expect(extractPdfText(encrypted(), 'nope')).rejects.toBeInstanceOf(
      IncorrectPasswordError,
    );
  });

  it('reads an encrypted statement given the right password', async () => {
    const pages = await extractPdfText(encrypted(), PASSWORD);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].items.length).toBeGreaterThan(50);
  });

  it('reads the encrypted file to exactly the same text as the plain one', async () => {
    // Same statement, same rows; only the encryption differs. If these ever
    // diverge, one of the two fixtures has drifted.
    const [a, b] = await Promise.all([
      extractPdfText(plain()),
      extractPdfText(encrypted(), PASSWORD),
    ]);

    expect(b.length).toBe(a.length);
    expect(b.map((p) => p.items.map((i) => i.text))).toEqual(
      a.map((p) => p.items.map((i) => i.text)),
    );
  });
});
