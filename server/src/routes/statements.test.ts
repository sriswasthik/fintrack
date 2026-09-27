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

// These tests stub the reader, so it is safe to switch on (src/test/setup.ts).
beforeEach(() => {
  process.env.AI_STATEMENT_READER = 'on';
});
afterEach(() => {
  setStatementReader(undefined);
  process.env.AI_STATEMENT_READER = 'off';
});

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
    expect(response.body.via).toBe('layout');
    // No adapter claims the Phase 12 fixture, which is the point of it.
    expect(response.body.source).toBe('unknown');
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

    // A PDF with transactions but no recognisable table.
    const letter = await buildTextOnlyPdf(PROSE_STATEMENT);
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', letter, 'letter.pdf')
      .expect(200);

    expect(reader.read).toHaveBeenCalledOnce();
    expect(response.body.via).toBe('model');
    expect(response.body.modelCalls).toBe(1);
    expect(response.body.totalRows).toBe(1);
  });

  it('says so plainly when the fallback reader is not configured', async () => {
    setStatementReader({
      read: vi.fn().mockRejectedValue(new StatementReaderConfigurationError('no API key')),
    });

    const letter = await buildTextOnlyPdf(PROSE_STATEMENT);
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

  it('sends the reader only the transactions, with identifiers masked', async () => {
    const reader: StatementReader = {
      read: vi.fn().mockResolvedValue({ rows: [], errors: [], calls: 1 }),
    };
    setStatementReader(reader);

    await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', await buildTextOnlyPdf(PROSE_STATEMENT), 'statement.pdf');

    const sent = vi.mocked(reader.read).mock.calls[0][0];
    expect(sent).toContain('PAYTM*CHAI POINT 228.21');
    expect(sent).toContain('UPI/XXXXXX3210@ybl/RAMESH 500.00');
    // Nothing about the account holder leaves the server.
    expect(sent).not.toMatch(/A SAMPLE PERSON|123456789012|EXMP0001234|Example Road/);
  });

  it('does not call the reader for a PDF with no transactions in it', async () => {
    const reader: StatementReader = { read: vi.fn() };
    setStatementReader(reader);

    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', await buildTextOnlyPdf(), 'letter.pdf')
      .expect(422);

    expect(response.body.details.reason).toBe('unreadable-layout');
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('does not call the reader when the operator switched it off', async () => {
    const reader: StatementReader = { read: vi.fn() };
    setStatementReader(reader);
    process.env.AI_STATEMENT_READER = 'off';
    try {
      const response = await request(app)
        .post('/api/statements/parse')
        .set(authHeader())
        .field('accountId', ACCOUNT_ID)
        .attach('file', await buildTextOnlyPdf(PROSE_STATEMENT), 'statement.pdf')
        .expect(422);

      expect(response.body.details.reason).toBe('unsupported-layout');
      expect(response.body.error).toMatch(/switched off/);
      expect(reader.read).not.toHaveBeenCalled();
    } finally {
      process.env.AI_STATEMENT_READER = 'on';
    }
  });

  it('refuses a reader answer it could not validate', async () => {
    setStatementReader({
      read: vi
        .fn()
        .mockRejectedValue(new StatementReaderResponseError('The reader did not return JSON')),
    });

    const letter = await buildTextOnlyPdf(PROSE_STATEMENT);
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
async function buildTextOnlyPdf(
  lines = ['Dear customer,', 'Thank you for banking with us. Your statement follows overleaf.'],
): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );
  doc.fontSize(11);
  lines.forEach((line, i) => doc.text(line, 40, 60 + i * 30));
  doc.end();
  return done;
}

/**
 * Transactions no reader recognises — no table, no column titles — under the
 * kind of preamble every statement opens with. Every value is invented.
 */
const PROSE_STATEMENT = [
  'Account Holder: A SAMPLE PERSON',
  'Account No: 123456789012   IFSC: EXMP0001234',
  'Your activity this month:',
  '01/03/2026 you paid PAYTM*CHAI POINT 228.21',
  '02/03/2026 you paid UPI/9876543210@ybl/RAMESH 500.00',
  'Registered office: 1 Example Road',
];

// ---------------------------------------------------------------------------
// Batch import
// ---------------------------------------------------------------------------

const quarter = [
  'statement_hdfc_2026_04.pdf',
  'statement_hdfc_2026_05.pdf',
  'statement_hdfc_2026_06.pdf',
] as const;

const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** Attaches every file in the batch under the field the route expects. */
function batchRequest(names: readonly string[], fields: Record<string, string> = {}) {
  let req = request(app).post('/api/statements/parse-batch').set(authHeader());
  for (const [key, value] of Object.entries({ accountId: ACCOUNT_ID, ...fields })) {
    req = req.field(key, value);
  }
  for (const name of names) req = req.attach('files', fixture(name), name);
  return req;
}

describe('POST /api/statements/parse-batch', () => {
  it('reads a three-file quarter as one import', async () => {
    const response = await batchRequest(quarter).expect(200);

    expect(response.body.status).toBe('batch-preview');
    expect(response.body.filesParsed).toBe(3);
    expect(response.body.filesFailed).toBe(0);
    expect(response.body.files.map((f: { fileName: string }) => f.fileName)).toEqual([...quarter]);
    expect(response.body.files.every((f: { source: string }) => f.source === 'hdfc')).toBe(true);
  });

  it('numbers rows once across the batch, not once per file', async () => {
    // Which is what lets a duplicate point at a row the user can find, and what
    // lets the existing dedup see across files without knowing files exist.
    const response = await batchRequest(quarter).expect(200);
    const indexes = response.body.rows.map((r: { index: number }) => r.index);

    expect(indexes).toEqual(indexes.map((_: number, i: number) => i + 1));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it('catches the rows May repeats from April', async () => {
    // A real bank prints the tail of the previous period at the top of the
    // next. Imported one file at a time, those rows arrive twice.
    const response = await batchRequest(quarter).expect(200);

    expect(response.body.crossFileDuplicateCount).toBeGreaterThan(0);
    const crossFile = response.body.rows.filter((r: { duplicate: { reason: string } | null }) =>
      r.duplicate?.reason?.includes('.pdf'),
    );
    expect(crossFile).toHaveLength(response.body.crossFileDuplicateCount);
    expect(crossFile[0].duplicate.reason).toMatch(/statement_hdfc_2026_04\.pdf/);
  });

  it('tags every row with the file it came from', async () => {
    const response = await batchRequest(quarter).expect(200);
    const files = new Set(response.body.rows.map((r: { fileName: string }) => r.fileName));
    expect([...files].sort()).toEqual([...quarter]);
  });

  it('lists a locked file rather than failing the whole batch', async () => {
    const response = await batchRequest([quarter[0], 'statement_encrypted.pdf']).expect(200);

    expect(response.body.filesParsed).toBe(1);
    const locked = response.body.files.find(
      (f: { fileName: string }) => f.fileName === 'statement_encrypted.pdf',
    );
    expect(locked.status).toBe('needs-password');
    expect(locked.message).toMatch(/password-protected/i);
    // The file that did parse is still there to import.
    expect(response.body.totalRows).toBeGreaterThan(0);
  });

  it('unlocks a file when its password is supplied, by position', async () => {
    const response = await batchRequest([quarter[0], 'statement_encrypted.pdf'], {
      passwords: JSON.stringify({ 1: PASSWORD }),
    }).expect(200);

    expect(response.body.filesParsed).toBe(2);
    expect(response.body.files[1].status).toBe('parsed');
  });

  it('says which password was wrong, for the file it was wrong for', async () => {
    const response = await batchRequest([quarter[0], 'statement_encrypted.pdf'], {
      passwords: JSON.stringify({ 1: 'not-it' }),
    }).expect(200);

    expect(response.body.files[1].status).toBe('wrong-password');
    expect(response.body.files[1].message).toMatch(/did not open/i);
  });

  it('mixes formats in one batch, each read by its own adapter', async () => {
    const response = await batchRequest([
      'statement_sbi.pdf',
      'statement_phonepe.pdf',
      'statement_axis.pdf',
    ]).expect(200);

    expect(response.body.files.map((f: { source: string }) => f.source)).toEqual([
      'sbi',
      'phonepe',
      'unknown',
    ]);
    expect(response.body.files.map((f: { via: string }) => f.via)).toEqual([
      'adapter',
      'adapter',
      'layout',
    ]);
  });

  it('carries the UPI fields through to the rows', async () => {
    const response = await batchRequest(['statement_phonepe.pdf']).expect(200);
    const rows = response.body.rows as { counterpartyRaw: string; upiVpa: string }[];

    expect(rows.every((r) => r.counterpartyRaw)).toBe(true);
    expect(rows.every((r) => r.upiVpa?.includes('@'))).toBe(true);
  });

  it('refuses an account belonging to somebody else', async () => {
    db.accountFindFirst.mockResolvedValue(null);
    await batchRequest([quarter[0]], { accountId: 'acct_someone_else' }).expect(404);
  });

  it('needs at least one file', async () => {
    await request(app)
      .post('/api/statements/parse-batch')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .expect(400);
  });

  it('is behind the session like every other data route', async () => {
    await request(app)
      .post('/api/statements/parse-batch')
      .field('accountId', ACCOUNT_ID)
      .attach('files', fixture(quarter[0]), quarter[0])
      .expect(401);
  });
});

describe('single-file parse, now that adapters exist', () => {
  it.each([
    ['statement_sbi.pdf', 'sbi', 'adapter'],
    ['statement_hdfc.pdf', 'hdfc', 'adapter'],
    ['statement_phonepe.pdf', 'phonepe', 'adapter'],
    ['statement_axis.pdf', 'unknown', 'layout'],
  ])('reads %s through %s', async (name, source, via) => {
    const response = await request(app)
      .post('/api/statements/parse')
      .set(authHeader())
      .field('accountId', ACCOUNT_ID)
      .attach('file', fixture(name), name)
      .expect(200);

    expect(response.body.source).toBe(source);
    expect(response.body.via).toBe(via);
    expect(response.body.modelCalls).toBe(0);
    expect(response.body.totalRows).toBeGreaterThan(0);
  });
});
