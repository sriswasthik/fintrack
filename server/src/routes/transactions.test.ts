import { readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The upload route reads existing transactions to detect duplicates and the
// commit route inserts. Both go through src/db.ts, which is mocked here so the
// suite needs no database — CI runs it without Postgres.
const db = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionCreateMany: vi.fn(),
  transactionFindUnique: vi.fn(),
  transactionUpdate: vi.fn(),
  transactionUpdateMany: vi.fn(),
  transactionCount: vi.fn(),
  ruleFindMany: vi.fn(),
  splitDeleteMany: vi.fn(),
  splitCreateMany: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('../db', () => ({
  getPrisma: () => prismaMock,
}));

// vi.mock is hoisted above these imports, so `app` already sees the mocked db.
import { app } from '../app';

const ACCOUNT_ID = 'acct_checking';

const GENERIC_CSV = [
  'date,description,amount,account',
  '2026-03-01,OAKWOOD PROPERTY MGMT,2150.00,Everyday Checking',
  '2026-03-01,SQ *JOES COFFEE,5.25,Sapphire Credit Card',
  '2026-03-01,SQ *JOES COFFEE,5.25,Sapphire Credit Card',
  '2026-03-02,NORTHWIND LABS DIRECT DEP,-3421.55,Everyday Checking',
].join('\r\n');

function upload(csv: string, fields: Record<string, string> = {}) {
  const req = request(app)
    .post('/api/transactions/upload')
    .field('accountId', ACCOUNT_ID)
    .attach('file', Buffer.from(csv), 'export.csv');
  Object.entries(fields).forEach(([key, value]) => void req.field(key, value));
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.accountFindUnique.mockResolvedValue({
    id: ACCOUNT_ID,
    name: 'Everyday Checking',
    userId: 'user_1',
  });
  db.transactionFindMany.mockResolvedValue([]);
  db.transactionCreateMany.mockResolvedValue({ count: 0 });
  db.transactionFindUnique.mockResolvedValue(null);
  db.transactionUpdate.mockResolvedValue({});
  db.transactionUpdateMany.mockResolvedValue({ count: 0 });
  db.transactionCount.mockResolvedValue(0);
  db.ruleFindMany.mockResolvedValue([]);
  db.splitDeleteMany.mockResolvedValue({ count: 0 });
  db.splitCreateMany.mockResolvedValue({ count: 0 });

  Object.assign(prismaMock, {
    account: { findUnique: db.accountFindUnique },
    transaction: {
      findMany: db.transactionFindMany,
      createMany: db.transactionCreateMany,
      findUnique: db.transactionFindUnique,
      update: db.transactionUpdate,
      updateMany: db.transactionUpdateMany,
      count: db.transactionCount,
    },
    rule: { findMany: db.ruleFindMany },
    split: { deleteMany: db.splitDeleteMany, createMany: db.splitCreateMany },
    // applyRuleEngine wraps its writes in an interactive transaction; the split
    // endpoint uses the array form. Support both.
    $transaction: (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prismaMock)
        : Promise.all(arg as unknown[]),
  });
});

describe('POST /api/transactions/upload', () => {
  it('parses a generic export and returns a normalized preview', async () => {
    const response = await upload(GENERIC_CSV).expect(200);

    expect(response.body.status).toBe('preview');
    expect(response.body.preset).toBe('generic');
    expect(response.body.totalRows).toBe(4);
    expect(response.body.rows[1]).toMatchObject({
      index: 2,
      date: '2026-03-01',
      rawMerchant: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
      amount: 5.25,
    });
  });

  it('writes nothing to the database', async () => {
    await upload(GENERIC_CSV).expect(200);
    expect(db.transactionCreateMany).not.toHaveBeenCalled();
  });

  it('flags the second of two identical rows in the same file', async () => {
    const response = await upload(GENERIC_CSV).expect(200);

    expect(response.body.duplicateCount).toBe(1);
    expect(response.body.rows[1].duplicate).toBeNull();
    expect(response.body.rows[2].duplicate).toMatchObject({ kind: 'in-file', matchesRowIndex: 2 });
  });

  it('flags a row that already exists on the account', async () => {
    db.transactionFindMany.mockResolvedValue([
      {
        id: 'txn_existing',
        date: new Date('2026-03-01T00:00:00.000Z'),
        amount: 2150,
        normalizedMerchant: 'OAKWOOD PROPERTY MGMT',
      },
    ]);

    const response = await upload(GENERIC_CSV).expect(200);

    expect(response.body.rows[0].duplicate).toMatchObject({
      kind: 'existing',
      existingTransactionId: 'txn_existing',
    });
  });

  it('queries only the date span of the upload, widened by the dedup window', async () => {
    await upload(GENERIC_CSV).expect(200);

    const where = db.transactionFindMany.mock.calls[0][0].where;
    expect(where.accountId).toBe(ACCOUNT_ID);
    expect(where.date.gte.toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(where.date.lte.toISOString().slice(0, 10)).toBe('2026-03-03');
  });

  it('returns the raw headers when no preset matches, so the client can map them', async () => {
    const unknown = [
      'Posted,Merchant Name,Debit',
      '2026-03-01,ACME STORE 1234,10.00',
      '2026-03-02,BETA CORP,11.00',
    ].join('\n');

    const response = await upload(unknown).expect(200);

    expect(response.body.status).toBe('needs-mapping');
    expect(response.body.headers).toEqual(['Posted', 'Merchant Name', 'Debit']);
    expect(response.body.sampleRows).toHaveLength(2);
    expect(response.body.requiredFields).toEqual(['date', 'description', 'amount']);
    expect(response.body.knownPresets.map((p: { id: string }) => p.id)).toEqual([
      'chase',
      'amex',
      'generic',
    ]);
  });

  it('accepts an explicit mapping for an unrecognised layout', async () => {
    const unknown = ['Posted,Merchant Name,Debit', '2026-03-01,ACME STORE 1234,10.00'].join('\n');

    const response = await upload(unknown, {
      mapping: JSON.stringify({
        date: 'Posted',
        description: 'Merchant Name',
        amount: 'Debit',
        amountSign: 'debit-positive',
      }),
    }).expect(200);

    expect(response.body.status).toBe('preview');
    expect(response.body.preset).toBe('custom');
    expect(response.body.rows[0]).toMatchObject({ normalizedMerchant: 'ACME', amount: 10 });
  });

  it('detects a Chase export and flips its sign convention', async () => {
    const chase = [
      'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
      '03/01/2026,03/03/2026,SQ *JOES COFFEE,Food & Drink,Sale,-5.25,',
    ].join('\n');

    const response = await upload(chase).expect(200);

    expect(response.body.preset).toBe('chase');
    expect(response.body.rows[0]).toMatchObject({ amount: 5.25, postedDate: '2026-03-03' });
  });

  it('reports unparseable rows separately from the good ones', async () => {
    const messy = [
      'date,description,amount',
      '2026-03-01,GOOD ROW,10.00',
      'not-a-date,BAD ROW,10.00',
    ].join('\n');

    const response = await upload(messy).expect(200);

    expect(response.body.totalRows).toBe(1);
    expect(response.body.skippedRows).toHaveLength(1);
    expect(response.body.skippedRows[0]).toMatchObject({ index: 2 });
  });

  it('rejects a request with no file', async () => {
    const response = await request(app)
      .post('/api/transactions/upload')
      .field('accountId', ACCOUNT_ID)
      .expect(400);

    expect(response.body.error).toMatch(/file/i);
  });

  it('rejects a missing accountId', async () => {
    await request(app)
      .post('/api/transactions/upload')
      .attach('file', Buffer.from(GENERIC_CSV), 'export.csv')
      .expect(400);
  });

  it('404s for an account that does not exist', async () => {
    db.accountFindUnique.mockResolvedValue(null);
    const response = await upload(GENERIC_CSV).expect(404);
    expect(response.body.error).toMatch(/account/i);
  });

  it('rejects a non-CSV upload', async () => {
    await request(app)
      .post('/api/transactions/upload')
      .field('accountId', ACCOUNT_ID)
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'statement.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('rejects an empty file', async () => {
    const response = await upload('   ').expect(400);
    expect(response.body.error).toMatch(/empty/i);
  });
});

describe('POST /api/transactions/upload with the Phase 1 synthetic export', () => {
  const csv = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'test-data', 'synthetic_transactions.csv'),
    'utf8',
  );

  it('parses every row of the committed fixture', async () => {
    const response = await upload(csv).expect(200);

    expect(response.body.status).toBe('preview');
    expect(response.body.preset).toBe('generic');
    expect(response.body.skippedRows).toEqual([]);
    expect(response.body.totalRows).toBe(csv.trimEnd().split('\r\n').length - 1);
  });

  it('flags the planted sync-glitch duplicates (§8 case 5)', async () => {
    const response = await upload(csv).expect(200);

    // Six glitch pairs plus the four legitimate same-day, same-price coffee
    // repeats, which are indistinguishable by value and so are flagged too.
    expect(response.body.duplicateCount).toBe(10);
    expect(
      response.body.rows
        .filter((r: { duplicate: unknown }) => r.duplicate)
        .every((r: { duplicate: { kind: string } }) => r.duplicate.kind === 'in-file'),
    ).toBe(true);
  });

  it('normalizes the processor-mangled descriptors (§8 case 8)', async () => {
    const response = await upload(csv).expect(200);
    const byRaw = new Map<string, string>(
      response.body.rows.map((r: { rawMerchant: string; normalizedMerchant: string }) => [
        r.rawMerchant,
        r.normalizedMerchant,
      ]),
    );

    expect(byRaw.get('SQ *JOES COFFEE')).toBe('JOES COFFEE');
    expect(byRaw.get('TST* RAMEN TATSU-YA')).toBe('RAMEN TATSU-YA');
    expect(byRaw.get('PAYPAL *STEAMGAMES')).toBe('STEAM');
    expect(byRaw.get('DOORDASH*THAI BASIL')).toBe('DOORDASH');
  });
});

describe('POST /api/transactions/commit', () => {
  const rows = [
    {
      index: 1,
      date: '2026-03-01',
      postedDate: '2026-03-03',
      description: 'SQ *JOES COFFEE',
      rawMerchant: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
      amount: 5.25,
    },
    {
      index: 2,
      date: '2026-03-01',
      postedDate: null,
      description: 'SQ *JOES COFFEE',
      rawMerchant: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
      amount: 5.25,
    },
  ];

  it('inserts every row as UNCATEGORIZED with zero confidence', async () => {
    const response = await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: ACCOUNT_ID, rows, resolutions: {} })
      .expect(201);

    expect(response.body).toMatchObject({ accountId: ACCOUNT_ID, imported: 2, skipped: 0 });

    const inserted = db.transactionCreateMany.mock.calls[0][0].data;
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      description: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
      amount: '5.25',
      currency: 'USD',
      category: 'UNCATEGORIZED',
      confidence: 0,
    });
    expect(inserted[0].date.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(inserted[1].postedDate).toBeNull();
  });

  it('honours a skip resolution', async () => {
    const response = await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: ACCOUNT_ID, rows, resolutions: { '2': 'skip' } })
      .expect(201);

    expect(response.body).toMatchObject({ accountId: ACCOUNT_ID, imported: 1, skipped: 1 });
    expect(db.transactionCreateMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('imports a flagged row when the user chooses keep', async () => {
    await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: ACCOUNT_ID, rows, resolutions: { '2': 'keep' } })
      .expect(201);

    expect(db.transactionCreateMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('does not touch the database when every row is skipped', async () => {
    const response = await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: ACCOUNT_ID, rows, resolutions: { '1': 'skip', '2': 'skip' } })
      .expect(201);

    expect(response.body.imported).toBe(0);
    expect(db.transactionCreateMany).not.toHaveBeenCalled();
  });

  it('rejects an empty row set', async () => {
    await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: ACCOUNT_ID, rows: [], resolutions: {} })
      .expect(400);
  });

  it('rejects a malformed row', async () => {
    await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: ACCOUNT_ID, rows: [{ ...rows[0], date: '01/03/2026' }], resolutions: {} })
      .expect(400);
  });

  it('404s for an unknown account', async () => {
    db.accountFindUnique.mockResolvedValue(null);
    await request(app)
      .post('/api/transactions/commit')
      .send({ accountId: 'nope', rows, resolutions: {} })
      .expect(404);
  });
});

describe('POST /api/transactions/:id/split (§8 case 3)', () => {
  const TXN_ID = 'txn_target';

  beforeEach(() => {
    db.transactionFindUnique.mockResolvedValue({
      id: TXN_ID,
      accountId: ACCOUNT_ID,
      date: new Date('2026-03-09T00:00:00.000Z'),
      postedDate: null,
      description: 'TARGET 0002341',
      rawMerchant: 'TARGET 0002341',
      normalizedMerchant: 'TARGET',
      amount: 187.43,
      currency: 'USD',
      category: 'SHOPPING',
      confidence: 1,
      source: 'RULE',
      transferPairId: null,
      linkedRefundId: null,
      splits: [],
    });
  });

  function split(splits: unknown[]) {
    return request(app).post(`/api/transactions/${TXN_ID}/split`).send({ splits });
  }

  it('accepts parts that sum exactly to the transaction total', async () => {
    await split([
      { category: 'GROCERIES', amount: 96.4, note: 'Weekly food shop' },
      { category: 'PERSONAL_CARE', amount: 41.15 },
      { category: 'SHOPPING', amount: 49.88 },
    ]).expect(201);

    const created = db.splitCreateMany.mock.calls[0][0].data;
    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({
      transactionId: TXN_ID,
      category: 'GROCERIES',
      amount: '96.40',
      note: 'Weekly food shop',
    });
    expect(created[1].note).toBeNull();
  });

  it('rejects parts that sum to less than the total', async () => {
    const response = await split([
      { category: 'GROCERIES', amount: 96.4 },
      { category: 'SHOPPING', amount: 41.15 },
    ]).expect(400);

    expect(response.body.error).toMatch(/sum to the transaction total/i);
    expect(response.body.details).toMatchObject({
      transactionTotal: 187.43,
      splitTotal: 137.55,
      difference: -49.88,
    });
    expect(db.splitCreateMany).not.toHaveBeenCalled();
  });

  it('rejects parts that sum to more than the total', async () => {
    const response = await split([
      { category: 'GROCERIES', amount: 100 },
      { category: 'SHOPPING', amount: 100 },
    ]).expect(400);

    expect(response.body.details.difference).toBeCloseTo(12.57, 2);
  });

  it('rejects a one-cent discrepancy', async () => {
    await split([
      { category: 'GROCERIES', amount: 96.4 },
      { category: 'PERSONAL_CARE', amount: 41.15 },
      { category: 'SHOPPING', amount: 49.87 },
    ]).expect(400);
  });

  it('compares in whole cents, so float arithmetic does not reject a valid split', async () => {
    db.transactionFindUnique.mockResolvedValue({
      id: TXN_ID,
      accountId: ACCOUNT_ID,
      date: new Date('2026-03-09T00:00:00.000Z'),
      postedDate: null,
      description: 'X',
      rawMerchant: 'X',
      normalizedMerchant: 'X',
      amount: 0.3,
      currency: 'USD',
      category: 'SHOPPING',
      confidence: 1,
      source: 'RULE',
      transferPairId: null,
      linkedRefundId: null,
      splits: [],
    });

    await split([
      { category: 'GROCERIES', amount: 0.1 },
      { category: 'SHOPPING', amount: 0.2 },
    ]).expect(201);
  });

  it('splits a negative transaction as readily as a positive one', async () => {
    db.transactionFindUnique.mockResolvedValue({
      id: TXN_ID,
      accountId: ACCOUNT_ID,
      date: new Date('2026-03-09T00:00:00.000Z'),
      postedDate: null,
      description: 'REFUND',
      rawMerchant: 'REFUND',
      normalizedMerchant: 'X',
      amount: -50,
      currency: 'USD',
      category: 'REFUND',
      confidence: 1,
      source: 'RULE',
      transferPairId: null,
      linkedRefundId: null,
      splits: [],
    });

    await split([
      { category: 'GROCERIES', amount: -20 },
      { category: 'SHOPPING', amount: -30 },
    ]).expect(201);
  });

  it('replaces any previous split rather than appending to it', async () => {
    await split([
      { category: 'GROCERIES', amount: 96.4 },
      { category: 'SHOPPING', amount: 91.03 },
    ]).expect(201);

    expect(db.splitDeleteMany).toHaveBeenCalledWith({ where: { transactionId: TXN_ID } });
  });

  it('requires at least two parts — one part is a recategorization, not a split', async () => {
    await split([{ category: 'GROCERIES', amount: 187.43 }]).expect(400);
    expect(db.splitCreateMany).not.toHaveBeenCalled();
  });

  it('rejects a category outside the taxonomy', async () => {
    await split([
      { category: 'SNACKS', amount: 96.4 },
      { category: 'SHOPPING', amount: 91.03 },
    ]).expect(400);
  });

  it('404s for a transaction that does not exist', async () => {
    db.transactionFindUnique.mockResolvedValue(null);
    await split([
      { category: 'GROCERIES', amount: 1 },
      { category: 'SHOPPING', amount: 1 },
    ]).expect(404);
  });

  it('clears a split on DELETE', async () => {
    db.splitDeleteMany.mockResolvedValue({ count: 3 });
    const response = await request(app).delete(`/api/transactions/${TXN_ID}/split`).expect(200);
    expect(response.body).toEqual({ removed: 3 });
  });
});
