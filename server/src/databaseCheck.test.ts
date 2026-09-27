import { afterEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from './generated/prisma/client';
import { checkDatabase } from './databaseCheck';

/** A client whose queries fail the way Prisma 7's pg adapter reports it. */
const failing = (cause: { kind?: string; originalCode?: string }) =>
  (() => ({
    $queryRaw: () =>
      Promise.reject(
        Object.assign(new Error('Raw query failed'), {
          code: 'P2010',
          meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
        }),
      ),
  })) as unknown as () => PrismaClient;

const saved = process.env.DATABASE_URL;
afterEach(() => {
  process.env.DATABASE_URL = saved;
});

describe('checkDatabase', () => {
  it('says the password is wrong, in words, and never repeats the URL', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/fintrack';
    const result = await checkDatabase(
      failing({ kind: 'AuthenticationFailed', originalCode: '28P01' }),
    );
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/username or password/) });
    expect(JSON.stringify(result)).not.toContain('postgres:postgres');
  });

  it('says when nothing is listening', async () => {
    process.env.DATABASE_URL = 'postgresql://x@localhost:1/db';
    const result = await checkDatabase(failing({ kind: 'DatabaseNotReachable' }));
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is PostgreSQL running/),
    });
  });

  it('says when the database does not exist', async () => {
    process.env.DATABASE_URL = 'postgresql://x@localhost/missing';
    const result = await checkDatabase(failing({ originalCode: '3D000' }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
  });

  it('says when the database has not been migrated', async () => {
    process.env.DATABASE_URL = 'postgresql://x@localhost/fresh';
    const result = await checkDatabase(failing({ originalCode: '42P01' }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/db:migrate/) });
  });

  it('says when DATABASE_URL is missing, without touching a client', async () => {
    process.env.DATABASE_URL = '';
    let built = false;
    const result = await checkDatabase(() => {
      built = true;
      throw new Error('should not be built');
    });
    expect(result).toEqual({ ok: false, reason: 'DATABASE_URL is not set' });
    expect(built).toBe(false);
  });

  it('is happy with a reachable, migrated database', async () => {
    process.env.DATABASE_URL = 'postgresql://x@localhost/ok';
    const ok = (() => ({
      $queryRaw: () => Promise.resolve([{ '?column?': 1 }]),
    })) as unknown as () => PrismaClient;
    expect(await checkDatabase(ok)).toEqual({ ok: true });
  });
});
