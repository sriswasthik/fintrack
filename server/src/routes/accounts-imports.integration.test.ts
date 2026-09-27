/**
 * Bank accounts and import history, against a real database (Phase 20).
 *
 * What a mock cannot show is the part that matters here: that deleting an
 * import or an account removes exactly the right rows by cascade, and that
 * the state computed *across* rows — a transfer pair, a payee — is rebuilt
 * afterwards rather than left pointing at nothing.
 *
 * Skips when no DATABASE_URL is configured; CI runs it against a service
 * container (see .github/workflows/ci.yml).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../app';
import { createPrismaClient } from '../db';
import type { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../services/auth/tokens';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'accounts-imports@fintrack.test';
const OTHER_EMAIL = 'accounts-imports-other@fintrack.test';

let prisma: PrismaClient;
let auth: { Authorization: string };
let otherAuth: { Authorization: string };

let checkingId: string;
let savingsId: string;
let checkingImportId: string;
let savingsImportId: string;

interface Row {
  index: number;
  date: string;
  description: string;
  rawMerchant: string;
  normalizedMerchant: string;
  amount: number;
  counterpartyRaw?: string | null;
  upiVpa?: string | null;
}

const row = (index: number, date: string, merchant: string, amount: number): Row => ({
  index,
  date,
  description: merchant,
  rawMerchant: merchant,
  normalizedMerchant: merchant,
  amount,
});

/**
 * Checking: a move of ₹5,000 out to savings, plus two ordinary purchases.
 * The move's narration matches no rule, so the only thing that makes it a
 * TRANSFER is the matching leg on the other account.
 */
const CHECKING_ROWS = [
  row(1, '2026-05-10', 'ZQX HOLDINGS 4021', 5000),
  row(2, '2026-05-12', 'SWIGGY', 450),
  row(3, '2026-05-14', 'BIGBASKET', 1250.5),
];

/** Savings: the incoming leg of the same move, a day later. */
const SAVINGS_ROWS = [row(1, '2026-05-11', 'ZQX HOLDINGS 4021', -5000)];

const commit = (accountId: string, rows: Row[], fileNames: string[], as = auth) =>
  request(app)
    .post('/api/transactions/commit')
    .set(as)
    .send({ accountId, rows, resolutions: {}, fileNames });

const findLeg = (accountId: string) =>
  prisma.transaction.findFirstOrThrow({
    where: { accountId, normalizedMerchant: 'ZQX HOLDINGS 4021' },
  });

async function cleanUp() {
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await cleanUp();

  const user = await prisma.user.create({ data: { email: EMAIL, name: 'New Person' } });
  const other = await prisma.user.create({ data: { email: OTHER_EMAIL, name: 'Somebody Else' } });
  auth = { Authorization: `Bearer ${signAccessToken(user.id)}` };
  otherAuth = { Authorization: `Bearer ${signAccessToken(other.id)}` };
});

afterAll(async () => {
  if (!hasDatabase) return;
  await cleanUp();
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('a new user’s bank accounts', () => {
  it('starts with none — the state that used to leave the import page empty', async () => {
    const response = await request(app).get('/api/accounts').set(auth).expect(200);
    expect(response.body.accounts).toEqual([]);
  });

  it('creates accounts, and refuses a second one with the same name', async () => {
    const checking = await request(app)
      .post('/api/accounts')
      .set(auth)
      .send({ name: 'HDFC Savings', type: 'CHECKING' })
      .expect(201);
    checkingId = checking.body.account.id;
    expect(checking.body.account).toMatchObject({ name: 'HDFC Savings', transactionCount: 0 });

    const savings = await request(app)
      .post('/api/accounts')
      .set(auth)
      .send({ name: 'SBI Savings', type: 'SAVINGS' })
      .expect(201);
    savingsId = savings.body.account.id;

    await request(app)
      .post('/api/accounts')
      .set(auth)
      .send({ name: 'SBI Savings', type: 'SAVINGS' })
      .expect(409);
  });

  it('renames an account, and refuses a name another of theirs already has', async () => {
    const renamed = await request(app)
      .patch(`/api/accounts/${checkingId}`)
      .set(auth)
      .send({ name: 'HDFC Salary' })
      .expect(200);
    expect(renamed.body.account).toMatchObject({ id: checkingId, name: 'HDFC Salary' });

    await request(app)
      .patch(`/api/accounts/${checkingId}`)
      .set(auth)
      .send({ name: 'SBI Savings' })
      .expect(409);
  });
});

describe.skipIf(!hasDatabase)('import history', () => {
  it('records each confirmed import, with its files and the dates it covers', async () => {
    const first = await commit(checkingId, CHECKING_ROWS, ['hdfc_may.pdf']).expect(201);
    checkingImportId = first.body.importId;
    const second = await commit(savingsId, SAVINGS_ROWS, ['sbi_may.pdf']).expect(201);
    savingsImportId = second.body.importId;

    const response = await request(app).get('/api/imports').set(auth).expect(200);

    // Newest first.
    expect(response.body.imports.map((i: { id: string }) => i.id)).toEqual([
      savingsImportId,
      checkingImportId,
    ]);
    expect(response.body.imports[1]).toMatchObject({
      account: { id: checkingId, name: 'HDFC Salary' },
      fileNames: ['hdfc_may.pdf'],
      rowCount: 3,
      remaining: 3,
      from: '2026-05-10',
      to: '2026-05-14',
    });
  });

  it('pairs the two legs of the move once both are in', async () => {
    const out = await findLeg(checkingId);
    const inn = await findLeg(savingsId);
    expect(out.transferPairId).toBe(inn.id);
    expect(out.category).toBe('TRANSFER');
    expect(inn.category).toBe('TRANSFER');
  });

  it('undoes one import: exactly its rows go, and the transfer it was half of comes apart', async () => {
    const response = await request(app)
      .delete(`/api/imports/${savingsImportId}`)
      .set(auth)
      .expect(200);
    expect(response.body.removedTransactions).toBe(1);

    expect(await prisma.transaction.count({ where: { accountId: savingsId } })).toBe(0);
    expect(await prisma.transaction.count({ where: { accountId: checkingId } })).toBe(3);

    // The surviving leg is no longer a transfer: nothing on another account
    // matches it now, and no rule knows the narration.
    const out = await findLeg(checkingId);
    expect(out.transferPairId).toBeNull();
    expect(out.category).toBe('UNCATEGORIZED');

    const history = await request(app).get('/api/imports').set(auth).expect(200);
    expect(history.body.imports.map((i: { id: string }) => i.id)).toEqual([checkingImportId]);
  });

  it('keeps another user out of both the list and the undo', async () => {
    const theirs = await request(app).get('/api/imports').set(otherAuth).expect(200);
    expect(theirs.body.imports).toEqual([]);

    await request(app).delete(`/api/imports/${checkingImportId}`).set(otherAuth).expect(404);
    expect(await prisma.transaction.count({ where: { accountId: checkingId } })).toBe(3);
  });
});

describe.skipIf(!hasDatabase)('deleting an account', () => {
  it('refuses somebody else, whatever the id', async () => {
    await request(app).delete(`/api/accounts/${checkingId}`).set(otherAuth).expect(404);
    await request(app)
      .patch(`/api/accounts/${checkingId}`)
      .set(otherAuth)
      .send({ name: 'Mine now' })
      .expect(404);
  });

  it('takes its transactions and imports with it, and prunes a payee left with nothing', async () => {
    // A person paid only from savings, so their ledger entry lives or dies
    // with that account.
    await commit(
      savingsId,
      [
        {
          ...row(1, '2026-05-20', 'UPI', 800),
          description: 'Paid to Ramesh Kumar',
          counterpartyRaw: 'Ramesh Kumar',
          upiVpa: 'rameshkumar@ybl',
        },
      ],
      ['phonepe_may.pdf'],
    ).expect(201);

    const userId = (await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })).id;
    const payee = await prisma.payee.findFirst({ where: { userId, upiVpa: 'rameshkumar@ybl' } });
    expect(payee).not.toBeNull();

    const listed = await request(app).get('/api/accounts').set(auth).expect(200);
    expect(
      listed.body.accounts.find((a: { id: string }) => a.id === savingsId).transactionCount,
    ).toBe(1);

    const response = await request(app).delete(`/api/accounts/${savingsId}`).set(auth).expect(200);
    expect(response.body).toMatchObject({ removedTransactions: 1, payeesRemoved: 1 });

    expect(await prisma.payee.findUnique({ where: { id: payee!.id } })).toBeNull();
    expect(await prisma.importBatch.count({ where: { accountId: savingsId } })).toBe(0);

    const after = await request(app).get('/api/accounts').set(auth).expect(200);
    expect(after.body.accounts.map((a: { id: string }) => a.id)).toEqual([checkingId]);
    // The other account is untouched.
    expect(await prisma.transaction.count({ where: { accountId: checkingId } })).toBe(3);
  });
});
