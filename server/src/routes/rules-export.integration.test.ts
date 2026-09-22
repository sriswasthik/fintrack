/**
 * Learned rules and the CSV export, against a real database (Phase 20).
 *
 * The rules claim is a precedence claim — a changed or deleted rule moves the
 * rows the engine decided and never the rows a person decided — and only the
 * real engine over real rows can show it. The export claim is about bytes,
 * so it is checked on the bytes.
 *
 * Skips when no DATABASE_URL is configured.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../services/auth/tokens';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'rules-export@fintrack.test';
const OTHER_EMAIL = 'rules-export-other@fintrack.test';

let prisma: PrismaClient;
let auth: { Authorization: string };
let otherAuth: { Authorization: string };
let accountId: string;
let otherAccountId: string;
let ruleId: string;

const row = (
  index: number,
  date: string,
  merchant: string,
  amount: number,
  description = merchant,
) => ({
  index,
  date,
  description,
  rawMerchant: merchant,
  normalizedMerchant: merchant,
  amount,
});

const commit = (rows: ReturnType<typeof row>[]) =>
  request(app)
    .post('/api/transactions/commit')
    .set(auth)
    .send({ accountId, rows, resolutions: {} })
    .expect(201);

const adda = () =>
  prisma.transaction.findMany({
    where: { accountId, normalizedMerchant: 'THE ADDA' },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, category: true, source: true },
  });

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();

  const user = await prisma.user.create({
    data: { email: EMAIL, accounts: { create: { name: 'HDFC Savings', type: 'CHECKING' } } },
    include: { accounts: true },
  });
  const other = await prisma.user.create({
    data: { email: OTHER_EMAIL, accounts: { create: { name: 'Theirs', type: 'CHECKING' } } },
    include: { accounts: true },
  });
  accountId = user.accounts[0].id;
  otherAccountId = other.accounts[0].id;
  auth = { Authorization: `Bearer ${signAccessToken(user.id)}` };
  otherAuth = { Authorization: `Bearer ${signAccessToken(other.id)}` };

  // THE ADDA is the dataset's genuinely ambiguous merchant: no rule knows it.
  await commit([
    row(1, '2026-05-03', 'THE ADDA', 640),
    row(2, '2026-05-17', 'SWIGGY', 380),
    row(3, '2026-05-21', 'NORTHWIND LABS SALARY', -85000),
    row(
      4,
      '2026-05-25',
      '=HYPERLINK("http://evil.test","x")',
      99,
      '=HYPERLINK("http://evil.test","x")',
    ),
  ]);
});

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('learned rules', () => {
  it('lists nothing before anything has been taught', async () => {
    const response = await request(app).get('/api/rules').set(auth).expect(200);
    expect(response.body.rules).toEqual([]);
  });

  it('lists the rule a correction taught, with the rows it is about', async () => {
    const [first] = await adda();
    expect(first.category).toBe('UNCATEGORIZED');

    await request(app)
      .post(`/api/transactions/${first.id}/category`)
      .set(auth)
      .send({ category: 'DINING' })
      .expect(200);

    // A second visit, imported after the correction: the rule settles it.
    await commit([row(1, '2026-06-02', 'THE ADDA', 720)]);

    const response = await request(app).get('/api/rules').set(auth).expect(200);
    expect(response.body.rules).toHaveLength(1);
    expect(response.body.rules[0]).toMatchObject({
      pattern: '^THE ADDA$',
      merchant: 'THE ADDA',
      category: 'DINING',
      learnedFromOverride: true,
      transactionCount: 2,
    });
    ruleId = response.body.rules[0].id;

    const [manual, byRule] = await adda();
    expect(manual).toMatchObject({ category: 'DINING', source: 'MANUAL' });
    expect(byRule).toMatchObject({ category: 'DINING', source: 'RULE' });
  });

  it('changing the rule moves the rows it decided, and never the one a person decided', async () => {
    const response = await request(app)
      .patch(`/api/rules/${ruleId}`)
      .set(auth)
      .send({ category: 'ENTERTAINMENT' })
      .expect(200);
    expect(response.body.rule).toMatchObject({ category: 'ENTERTAINMENT', merchant: 'THE ADDA' });
    expect(response.body.recategorized).toBe(1);

    const [manual, byRule] = await adda();
    expect(manual).toMatchObject({ category: 'DINING', source: 'MANUAL' });
    expect(byRule.category).toBe('ENTERTAINMENT');
  });

  it('keeps another user from seeing, changing or deleting it', async () => {
    const theirs = await request(app).get('/api/rules').set(otherAuth).expect(200);
    expect(theirs.body.rules).toEqual([]);
    await request(app)
      .patch(`/api/rules/${ruleId}`)
      .set(otherAuth)
      .send({ category: 'SHOPPING' })
      .expect(404);
    await request(app).delete(`/api/rules/${ruleId}`).set(otherAuth).expect(404);
  });

  it('deleting the rule returns its rows to the queue, and leaves the correction standing', async () => {
    await request(app).delete(`/api/rules/${ruleId}`).set(auth).expect(200);

    const [manual, byRule] = await adda();
    expect(manual).toMatchObject({ category: 'DINING', source: 'MANUAL' });
    expect(byRule.category).toBe('UNCATEGORIZED');

    const response = await request(app).get('/api/rules').set(auth).expect(200);
    expect(response.body.rules).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)('GET /api/transactions/export', () => {
  const BOM = String.fromCharCode(0xfeff);
  const parse = (body: string) =>
    (body.startsWith(BOM) ? body.slice(1) : body).split('\r\n').filter(Boolean);

  it('downloads a CSV with a UTF-8 BOM and debits and credits in their own columns', async () => {
    const response = await request(app)
      .get('/api/transactions/export')
      .query({ month: '2026-05' })
      .set(auth)
      .buffer(true)
      .parse((res, done) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => done(null, data));
      })
      .expect(200);

    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="fintrack-transactions-2026-05.csv"',
    );

    const body = response.body as string;
    expect(body.charCodeAt(0)).toBe(0xfeff);

    const lines = parse(body);
    expect(lines[0]).toBe(
      'Date,Posted Date,Account,Description,Merchant,Category,Debit,Credit,Currency,Categorized By,Splits',
    );
    // Four May rows, oldest first; June's visit is outside the month.
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(
      /^2026-05-03,,HDFC Savings,THE ADDA,THE ADDA,DINING,640\.00,,INR,MANUAL,$/,
    );
    // Salary is money in: the Credit column, unsigned.
    expect(lines[3]).toMatch(/^2026-05-21,.*,,85000\.00,INR,/);
  });

  it('defuses a narration that a spreadsheet would run as a formula', async () => {
    const response = await request(app)
      .get('/api/transactions/export')
      .query({ from: '2026-05-25', to: '2026-05-25' })
      .set(auth)
      .expect(200);

    const lines = parse(response.text);
    expect(lines).toHaveLength(2);
    // Quoted by the CSV writer because of the embedded quotes and comma, and
    // led by an apostrophe so the cell is text.
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect(lines[1]).not.toMatch(/,=HYPERLINK/);
  });

  it('includes the last day of a range', async () => {
    const response = await request(app)
      .get('/api/transactions/export')
      .query({ from: '2026-05-01', to: '2026-05-21' })
      .set(auth)
      .expect(200);
    expect(parse(response.text)).toHaveLength(4);
  });

  it('refuses another user’s account rather than exporting nothing', async () => {
    await request(app)
      .get('/api/transactions/export')
      .query({ accountId: otherAccountId })
      .set(auth)
      .expect(404);
  });
});
