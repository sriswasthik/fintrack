/**
 * The payee ledger, against a real database.
 *
 * The whole feature is an arithmetic claim — "you have paid Sam ₹3,500 and Sam
 * has paid you ₹3,500, so you are square" — and the arithmetic is done by
 * Postgres, in a grouped query with FILTER clauses. A mocked Prisma would
 * assert that the handler calls the query; it could not tell you whether the
 * query adds up. So this suite builds real rows, runs the real pipeline over
 * them, and reads the totals back through the real HTTP route.
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
import { resolvePayees } from '../services/payees/resolve';
import { applyRuleEngine } from '../services/rules/apply';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const EMAIL = 'payee-ledger@fintrack.test';
const OTHER_EMAIL = 'payee-ledger-other@fintrack.test';

interface Row {
  date: string;
  description: string;
  merchant: string;
  /** Debit-positive: leaving the account is positive. */
  amount: number;
}

/**
 * The shape the Phase 1 generator plants for §8 case 9, with the amounts and
 * the lag it uses. Two people, each paid and then paid back, on four distinct
 * dates — which is precisely the question the ledger exists to answer.
 *
 * Sam is deliberately spread across three months rather than two, so "multiple
 * dates" cannot be satisfied by a single day's pair.
 */
const ROWS: Row[] = [
  // Sam: out, back, and a second, unequal round trip months later.
  { date: '2026-05-06', description: 'PAYTM WALLET TO SAM R', merchant: 'PAYTM WALLET', amount: 3500 },
  { date: '2026-05-11', description: 'PAYTM WALLET FROM SAM R', merchant: 'PAYTM WALLET', amount: -3500 },
  { date: '2026-07-02', description: 'PAYTM WALLET TO SAM R', merchant: 'PAYTM WALLET', amount: 1250.5 },
  { date: '2026-07-19', description: 'PAYTM WALLET FROM SAM R', merchant: 'PAYTM WALLET', amount: -400.25 },

  // Priya: one balanced round trip.
  { date: '2026-06-02', description: 'PAYTM WALLET TO PRIYA N', merchant: 'PAYTM WALLET', amount: 6000 },
  { date: '2026-06-08', description: 'PAYTM WALLET FROM PRIYA N', merchant: 'PAYTM WALLET', amount: -6000 },

  // A business, so the listing has something that is not a person in it.
  { date: '2026-06-03', description: 'SWIGGY', merchant: 'SWIGGY', amount: 480 },
  { date: '2026-06-17', description: 'SWIGGY', merchant: 'SWIGGY', amount: 655.75 },

  // A line with no counterparty at all. Must not become a payee.
  { date: '2026-06-21', description: 'ATW-41223 CASH WDL', merchant: 'ATW-41223 CASH WDL', amount: 5000 },
];

/** What Sam's numbers must come to. Written out so the test states the claim. */
const SAM = {
  paid: 3500 + 1250.5,
  received: 3500 + 400.25,
  get net() {
    return Math.round((this.paid - this.received) * 100) / 100;
  },
  transactions: 4,
  lastTransactionAt: '2026-07-19',
  firstTransactionAt: '2026-05-06',
};

let prisma: PrismaClient;
let userId: string;
let otherUserId: string;
let otherPayeeId: string;

function auth(id: string = userId) {
  return { Authorization: `Bearer ${signAccessToken(id)}` };
}

async function seedUser(email: string, rows: Row[]): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: 'not-a-real-hash',
      accounts: { create: [{ name: 'Everyday Checking', type: 'CHECKING' }] },
    },
    include: { accounts: true },
  });
  const accountId = user.accounts[0].id;

  await prisma.transaction.createMany({
    data: rows.map((row) => ({
      accountId,
      date: new Date(`${row.date}T00:00:00.000Z`),
      postedDate: new Date(`${row.date}T00:00:00.000Z`),
      description: row.description,
      rawMerchant: row.description,
      normalizedMerchant: row.merchant,
      amount: row.amount.toFixed(2),
      currency: 'INR',
    })),
  });

  // The real pipeline, in the real order: categories first, because whether a
  // line gets a payee depends on the category it ended up with.
  await applyRuleEngine(prisma, { userId: user.id });
  await resolvePayees(prisma, { userId: user.id });

  return user.id;
}

beforeAll(async () => {
  if (!hasDatabase) return;
  prisma = createPrismaClient();
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });

  userId = await seedUser(EMAIL, ROWS);
  otherUserId = await seedUser(OTHER_EMAIL, [
    { date: '2026-06-04', description: 'PAYTM WALLET TO SAM R', merchant: 'PAYTM WALLET', amount: 999 },
  ]);

  const otherPayee = await prisma.payee.findFirstOrThrow({
    where: { userId: otherUserId, displayName: 'SAM R' },
  });
  otherPayeeId = otherPayee.id;
}, 30000);

afterAll(async () => {
  if (!hasDatabase) return;
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDatabase)('GET /api/payees', () => {
  it('rolls a person up into one payee across every date they appear on', async () => {
    // The headline claim of the whole phase: Sam appears on four separate days,
    // in both directions, and is one row.
    const response = await request(app).get('/api/payees').set(auth()).expect(200);

    const sam = response.body.payees.filter(
      (p: { displayName: string }) => p.displayName === 'SAM R',
    );
    expect(sam).toHaveLength(1);
    expect(sam[0]).toMatchObject({
      displayName: 'SAM R',
      type: 'PERSON',
      transactions: SAM.transactions,
    });
  });

  it('adds up what was paid, what was received, and the difference', async () => {
    const response = await request(app).get('/api/payees').set(auth()).expect(200);
    const sam = response.body.payees.find(
      (p: { displayName: string }) => p.displayName === 'SAM R',
    );

    expect(sam.paid).toBeCloseTo(SAM.paid, 2);
    expect(sam.received).toBeCloseTo(SAM.received, 2);
    expect(sam.net).toBeCloseTo(SAM.net, 2);
    // Stated twice on purpose: the relationship between the three is the thing
    // being claimed, not the three numbers separately.
    expect(sam.net).toBeCloseTo(sam.paid - sam.received, 2);
  });

  it('reads a settled round trip as a net of exactly zero', async () => {
    const response = await request(app).get('/api/payees').set(auth()).expect(200);
    const priya = response.body.payees.find(
      (p: { displayName: string }) => p.displayName === 'PRIYA N',
    );

    expect(priya.paid).toBeCloseTo(6000, 2);
    expect(priya.received).toBeCloseTo(6000, 2);
    expect(priya.net).toBe(0);
  });

  it('dates the ledger by the most recent transaction, not the first', async () => {
    const response = await request(app).get('/api/payees').set(auth()).expect(200);
    const sam = response.body.payees.find(
      (p: { displayName: string }) => p.displayName === 'SAM R',
    );

    expect(sam.lastTransactionAt).toBe(SAM.lastTransactionAt);
    expect(sam.firstTransactionAt).toBe(SAM.firstTransactionAt);
  });

  it('gives a line with no counterparty no payee at all', async () => {
    // An ATM withdrawal moved money from an account to a pocket. Inventing a
    // payee called "ATW-41223 CASH WDL" would put a fiction in the ledger.
    const response = await request(app).get('/api/payees').set(auth()).expect(200);
    const names = response.body.payees.map((p: { displayName: string }) => p.displayName);

    expect(names).not.toContain('ATW-41223 CASH WDL');
    expect(names).toEqual(expect.arrayContaining(['SAM R', 'PRIYA N', 'SWIGGY']));
  });

  it('tells a person from a business', async () => {
    const response = await request(app).get('/api/payees').set(auth()).expect(200);
    const byName = new Map(
      response.body.payees.map((p: { displayName: string; type: string }) => [p.displayName, p.type]),
    );

    expect(byName.get('SAM R')).toBe('PERSON');
    expect(byName.get('PRIYA N')).toBe('PERSON');
    expect(byName.get('SWIGGY')).toBe('BUSINESS');
  });

  it.each([
    ['net', (p: { net: number }) => p.net],
    ['paid', (p: { paid: number }) => p.paid],
    ['received', (p: { received: number }) => p.received],
    ['transactions', (p: { transactions: number }) => p.transactions],
  ])('sorts by %s, descending by default', async (sort, read) => {
    const response = await request(app).get(`/api/payees?sort=${sort}`).set(auth()).expect(200);
    const values = response.body.payees.map(read);

    expect(values).toEqual([...values].sort((a, b) => Number(b) - Number(a)));
  });

  it('sorts by name A-Z by default, and reverses on request', async () => {
    const ascending = await request(app).get('/api/payees?sort=name').set(auth()).expect(200);
    const names = ascending.body.payees.map((p: { displayName: string }) => p.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    const descending = await request(app)
      .get('/api/payees?sort=name&direction=desc')
      .set(auth())
      .expect(200);
    expect(descending.body.payees.map((p: { displayName: string }) => p.displayName)).toEqual(
      [...names].reverse(),
    );
  });

  it('sorts by the most recent transaction', async () => {
    const response = await request(app)
      .get('/api/payees?sort=lastTransactionAt')
      .set(auth())
      .expect(200);
    const dates = response.body.payees.map((p: { lastTransactionAt: string }) => p.lastTransactionAt);

    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('searches by name, case-insensitively and on a substring', async () => {
    const response = await request(app).get('/api/payees?q=sam').set(auth()).expect(200);

    expect(response.body.payees).toHaveLength(1);
    expect(response.body.payees[0].displayName).toBe('SAM R');
  });

  it('rejects a sort column that is not on the list', async () => {
    // The sort is interpolated into SQL rather than parameterized, so the
    // allow-list is the whole defence.
    await request(app).get('/api/payees?sort=id;DROP TABLE "Payee"').set(auth()).expect(400);
    await request(app).get('/api/payees?sort=createdAt').set(auth()).expect(400);
  });

  it('never shows one user another user’s payees', async () => {
    const mine = await request(app).get('/api/payees').set(auth()).expect(200);
    const theirs = await request(app).get('/api/payees').set(auth(otherUserId)).expect(200);

    // Both users have a payee called SAM R. They are different rows with
    // different totals, and neither request may see the other's.
    const mySam = mine.body.payees.find((p: { displayName: string }) => p.displayName === 'SAM R');
    const theirSam = theirs.body.payees.find(
      (p: { displayName: string }) => p.displayName === 'SAM R',
    );

    expect(mySam.id).not.toBe(theirSam.id);
    expect(mySam.paid).toBeCloseTo(SAM.paid, 2);
    expect(theirSam.paid).toBeCloseTo(999, 2);
    expect(theirs.body.payees).toHaveLength(1);
  });

  it('requires a session', async () => {
    await request(app).get('/api/payees').expect(401);
  });

  it('does not grow the ledger when resolution runs again', async () => {
    // Resolution runs after every import and every re-categorization, so a
    // pass that created a duplicate payee each time would quietly double the
    // ledger on a user who imports monthly.
    const before = await request(app).get('/api/payees').set(auth()).expect(200);

    const second = await resolvePayees(prisma, { userId });
    expect(second.created).toBe(0);
    expect(second.linked).toBe(0);

    const after = await request(app).get('/api/payees').set(auth()).expect(200);
    expect(after.body.payees).toEqual(before.body.payees);
  });

  it('joins a later transaction to the payee its UPI address already names', async () => {
    // The same person, spelled differently by a different app. The address is
    // matched on before the name precisely so this lands on one row.
    const user = await prisma.user.create({
      data: {
        email: 'payee-ledger-vpa@fintrack.test',
        passwordHash: 'not-a-real-hash',
        accounts: { create: [{ name: 'Everyday Checking', type: 'CHECKING' }] },
      },
      include: { accounts: true },
    });
    const accountId = user.accounts[0].id;

    const row = (date: string, amount: number, counterpartyRaw: string) => ({
      accountId,
      date: new Date(`${date}T00:00:00.000Z`),
      description: `UPI/${counterpartyRaw}/9812345678@ybl`,
      rawMerchant: counterpartyRaw,
      normalizedMerchant: counterpartyRaw.toUpperCase(),
      counterpartyRaw,
      upiVpa: '9812345678@ybl',
      amount: amount.toFixed(2),
      currency: 'INR',
    });

    await prisma.transaction.createMany({
      data: [row('2026-06-01', 1200, 'Meena Sharma'), row('2026-06-20', -500, 'MEENA S')],
    });
    await applyRuleEngine(prisma, { userId: user.id });
    await resolvePayees(prisma, { userId: user.id });

    const response = await request(app).get('/api/payees').set(auth(user.id)).expect(200);

    expect(response.body.payees).toHaveLength(1);
    expect(response.body.payees[0]).toMatchObject({
      upiVpa: '9812345678@ybl',
      phone: '9812345678',
      transactions: 2,
    });
    expect(response.body.payees[0].paid).toBeCloseTo(1200, 2);
    expect(response.body.payees[0].received).toBeCloseTo(500, 2);

    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe.skipIf(!hasDatabase)('GET /api/payees/:id', () => {
  async function samId(): Promise<string> {
    const response = await request(app).get('/api/payees?q=SAM R').set(auth()).expect(200);
    return response.body.payees[0].id;
  }

  it('returns the same totals as the listing', async () => {
    const response = await request(app).get(`/api/payees/${await samId()}`).set(auth()).expect(200);

    expect(response.body.payee).toMatchObject({
      displayName: 'SAM R',
      type: 'PERSON',
      transactions: SAM.transactions,
    });
    expect(response.body.payee.paid).toBeCloseTo(SAM.paid, 2);
    expect(response.body.payee.received).toBeCloseTo(SAM.received, 2);
    expect(response.body.payee.net).toBeCloseTo(SAM.net, 2);
  });

  it('returns the full history, newest first, labelled by direction', async () => {
    const response = await request(app).get(`/api/payees/${await samId()}`).set(auth()).expect(200);
    const history = response.body.payee.transactionHistory;

    expect(history).toHaveLength(SAM.transactions);
    expect(history.map((t: { date: string }) => t.date)).toEqual([
      '2026-07-19',
      '2026-07-02',
      '2026-05-11',
      '2026-05-06',
    ]);
    expect(history.map((t: { direction: string }) => t.direction)).toEqual([
      'received',
      'paid',
      'received',
      'paid',
    ]);
  });

  it('has a history that adds up to the totals it reports', async () => {
    // The strongest form of the claim: the summary is not a separate number
    // that happens to look right, it is the rows.
    const response = await request(app).get(`/api/payees/${await samId()}`).set(auth()).expect(200);
    const { paid, received, net, transactionHistory } = response.body.payee;

    const sum = (predicate: (amount: number) => boolean) =>
      transactionHistory
        .map((t: { amount: number }) => t.amount)
        .filter(predicate)
        .reduce((total: number, amount: number) => total + amount, 0);

    expect(sum((a) => a > 0)).toBeCloseTo(paid, 2);
    expect(-sum((a) => a < 0)).toBeCloseTo(received, 2);
    expect(sum(() => true)).toBeCloseTo(net, 2);
  });

  it('names the account each transaction sits on', async () => {
    const response = await request(app).get(`/api/payees/${await samId()}`).set(auth()).expect(200);

    response.body.payee.transactionHistory.forEach((t: { accountName: string }) => {
      expect(t.accountName).toBe('Everyday Checking');
    });
  });

  it('answers 404 for another user’s payee rather than 403', async () => {
    // A 403 would confirm the id exists. A 404 says nothing either way.
    await request(app).get(`/api/payees/${otherPayeeId}`).set(auth()).expect(404);
  });

  it('answers 404 for an id that does not exist', async () => {
    await request(app).get('/api/payees/payee_nope').set(auth()).expect(404);
  });

  it('requires a session', async () => {
    await request(app).get(`/api/payees/${otherPayeeId}`).expect(401);
  });
});
