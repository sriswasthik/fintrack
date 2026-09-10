import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No database: the routes read existing rows to flag duplicates, and that is
// all they touch. CI runs this without Postgres.
const db = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  transactionFindMany: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../db', () => ({ getPrisma: () => prismaMock }));

import { app } from '../app';
import { setStatementReader } from '../controllers/statements';
import { authHeader, TEST_USER_ID } from '../test/auth';
import {
  StatementReaderConfigurationError,
  StatementReaderResponseError,
  type StatementReader,
} from '../services/ai/statement';

const ACCOUNT_ID = 'acct_checking';
const FIXTURES = join(__dirname, '..', '..', '..', 'test-data');
const PASSWORD = 'fintrack-test-password';

const plain = () => readFileSync(join(FIXTURES, 'statement_plain.pdf'));
const encrypted = () => readFileSync(join(FIXTURES, 'statement_encrypted.pdf'));

beforeEach(() => {
  vi.clearAllMocks();
  db.accountFindFirst.mockResolvedValue({ id: ACCOUNT_ID, userId: TEST_USER_ID });
  db.transactionFindMany.mockResolvedValue([]);
  Object.assign(prismaMock, {
    account: { findFirst: db.accountFindFirst },
    transaction: { findMany: db.transactionFindMany },
  });
});

afterEach(() => setStatementReader(undefined));

describe('POST /api/statements/inspect', () => {
  it('says a plain statement needs no password', async () => {
    const response = await request(app)
      .post('/api/statements/inspect')
      .set(authHeader())
      .attach('file', plain(), 'statement_plain.pdf')
      .expect(200);

    expect(response.body.requiresPassword).toBe(false);
  });

  it('says an encrypted one does — without being given a password', async () => {
    const response = await request(app)
      .post('/api/statements/inspect')
      .set(authHeader())
      .attach('file', encrypted(), 'statement_encrypted.pdf')
      .expect(200);

    expect(response.body.requiresPassword).toBe(true);
  });

  it('needs no account, because it writes nothing', async () => {
    await request(app)
      .post('/api/statements/inspect')
      .set(authHeader())
      .attach('file', plain(), 'statement_plain.pdf')
      .expect(200);

    expect(db.accountFindFirst).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a PDF', async () => {
    const response = await request(app)
      .post('/api/statements/inspect')
      .set(authHeader())
      .attach('file', Buffer.from('date,description,amount'), 'export.csv')
      .expect(400);

    expect(response.body.error).toMatch(/only \.pdf/i);
  });

  it('is behind the session like every other data route', async () => {
    await request(app)
      .post('/api/statements/inspect')
      .attach('file', plain(), 'statement_plain.pdf')
      .expect(401);
  });
});

describe('POST /api/statements/parse', () => {
  it('reads a plain statement into the preview the CSV path produces', async () => {
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', plain(), 'statement_plain.pdf')
      .expect(200);

    // Same envelope, so the client's confirm step and /transactions/commit
    // needed no changes.
    expect(response.body.status).toBe('preview');
    expect(response.body.source).toBe('layout');
    expect(response.body.totalRows).toBe(60);
    expect(response.body.skippedRows).toEqual([]);
    expect(response.body.rows[0]).toMatchObject({
      index: 1,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      normalizedMerchant: expect.any(String),
      amount: expect.any(Number),
    });
  });

  it('spends no model call when the layout is one it reads', async () => {
    const reader: StatementReader = { read: vi.fn() };
    setStatementReader(reader);

    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', plain(), 'statement_plain.pdf')
      .expect(200);

    expect(response.body.modelCalls).toBe(0);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('asks for a password rather than failing vaguely', async () => {
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', encrypted(), 'statement_encrypted.pdf')
      .expect(400);

    expect(response.body.details.reason).toBe('password-required');
    expect(response.body.error).toMatch(/password-protected/i);
  });

  it('says the password was wrong, which is a different thing', async () => {
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .field('password', 'definitely-not-it')
      .attach('file', encrypted(), 'statement_encrypted.pdf')
      .expect(400);

    expect(response.body.details.reason).toBe('incorrect-password');
    expect(response.body.error).toMatch(/did not open/i);
    // Emphatically not the "this file needs a password" message: they lead to
    // different next actions.
    expect(response.body.error).not.toMatch(/is password-protected/i);
  });

  it('imports nothing when the password is wrong', async () => {
    await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .field('password', 'definitely-not-it')
      .attach('file', encrypted(), 'statement_encrypted.pdf')
      .expect(400);

    // The parse route never writes, but it must not even get as far as reading
    // the account's existing rows on a failed unlock.
    expect(db.transactionFindMany).not.toHaveBeenCalled();
  });

  it('reads the encrypted statement to the same rows as the plain one', async () => {
    const [open, locked] = await Promise.all([
      request(app)
        .post('/api/statements/parse')
        .set(authHeader())
        .field('accountId', ACCOUNT_ID)
        .attach('file', plain(), 'statement_plain.pdf')
        .expect(200),
      request(app)
        .post('/api/statements/parse')
        .set(authHeader())
        .field('accountId', ACCOUNT_ID)
        .field('password', PASSWORD)
        .attach('file', encrypted(), 'statement_encrypted.pdf')
        .expect(200),
    ]);

    expect(locked.body.rows).toEqual(open.body.rows);
  });

  it('falls back to the reader when the layout is not one it knows', async () => {
    const reader: StatementReader = {
      read: vi.fn().mockResolvedValue({
        rows: [
          {
            index: 1,
            date: '2026-03-01',
            postedDate: null,
            description: 'PAYTM*CHAI POINT',
            rawMerchant: 'PAYTM*CHAI POINT',
            normalizedMerchant: 'CHAI POINT',
            amount: 228.21,
          },
        ],
        errors: [],
        calls: 1,
      }),
    };
    setStatementReader(reader);

    // A PDF with text but no recognisable table.
    const letter = await buildTextOnlyPdf();
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', letter, 'letter.pdf')
      .expect(200);

    expect(reader.read).toHaveBeenCalledOnce();
    expect(response.body.source).toBe('model');
    expect(response.body.modelCalls).toBe(1);
    expect(response.body.totalRows).toBe(1);
  });

  it('says so plainly when the fallback reader is not configured', async () => {
    setStatementReader({
      read: vi.fn().mockRejectedValue(new StatementReaderConfigurationError('no API key')),
    });

    const letter = await buildTextOnlyPdf();
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', letter, 'letter.pdf')
      .expect(422);

    expect(response.body.details.reason).toBe('unsupported-layout');
    // Names the situation without naming the credential.
    expect(response.body.error).toMatch(/not configured on this server/i);
    expect(response.body.error).not.toMatch(/api.?key/i);
  });

  it('refuses a reader answer it could not validate', async () => {
    setStatementReader({
      read: vi.fn().mockRejectedValue(
        new StatementReaderResponseError('The reader did not return JSON'),
      ),
    });

    const letter = await buildTextOnlyPdf();
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', letter, 'letter.pdf')
      .expect(422);

    expect(response.body.details.reason).toBe('unreadable-layout');
  });

  it('refuses an account belonging to somebody else', async () => {
    db.accountFindFirst.mockResolvedValue(null);

    await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', 'acct_someone_else')
      .attach('file', plain(), 'statement_plain.pdf')
      .expect(404);
  });
});

/** A PDF with prose and no table, to exercise the fallback path. */
async function buildTextOnlyPdf(): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.fontSize(11).text('Dear customer,', 40, 60);
  doc.text('Thank you for banking with us. Your statement follows overleaf.', 40, 90);
  doc.end();
  return done;
}
