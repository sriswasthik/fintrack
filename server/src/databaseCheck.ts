/**
 * Can the server reach its database, and has it been migrated? Asked once, at
 * startup.
 *
 * Without it, a wrong password in DATABASE_URL surfaces as a 500 on whatever
 * the first visitor happens to do — usually signing up — with the cause buried
 * in a stack trace. One line at startup that names the problem is the fix.
 *
 * The message never includes the connection string: it holds the password.
 */
import type { PrismaClient } from './generated/prisma/client';

const AUTH_FAILED =
  'the database rejected the username or password in DATABASE_URL — use the password you set when you installed PostgreSQL';
const UNREACHABLE =
  'nothing is answering at the host and port in DATABASE_URL — is PostgreSQL running?';
const NO_DATABASE =
  'the database named in DATABASE_URL does not exist — create it, then run `npm run db:migrate --workspace server`';
const NOT_MIGRATED =
  'the database has no FinTrack tables yet — run `npm run db:migrate --workspace server`';

/**
 * Prisma 7 with the pg driver adapter reports a failed connection as a generic
 * P2010, with the real cause — a Postgres SQLSTATE or a socket error — nested
 * inside. Classic engine codes are kept for completeness.
 */
function reasonFor(error: unknown): string {
  const err = error as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { kind?: string; originalCode?: string } } };
    cause?: { code?: string };
    message?: string;
  };
  const cause = err.meta?.driverAdapterError?.cause;
  const codes = [err.code, cause?.kind, cause?.originalCode, err.cause?.code].filter(Boolean);
  const has = (...candidates: string[]) => candidates.some((c) => codes.includes(c));

  if (has('P1000', 'AuthenticationFailed', '28P01', '28000')) return AUTH_FAILED;
  if (has('P1003', 'DatabaseDoesNotExist', '3D000')) return NO_DATABASE;
  if (has('P1001', 'DatabaseNotReachable', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'))
    return UNREACHABLE;
  if (has('TableDoesNotExist', '42P01')) return NOT_MIGRATED;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(err.message ?? '')) return UNREACHABLE;
  return `the database could not be used${codes[0] ? ` (${codes[0]})` : ''} — check DATABASE_URL`;
}

export type DatabaseCheck = { ok: true } | { ok: false; reason: string };

export async function checkDatabase(client: () => PrismaClient): Promise<DatabaseCheck> {
  if (!process.env.DATABASE_URL?.trim()) {
    return { ok: false, reason: 'DATABASE_URL is not set' };
  }
  try {
    const prisma = client();
    await prisma.$queryRaw`SELECT 1`;
    // Reachable is not the same as ready: a fresh database has no tables.
    await prisma.$queryRaw`SELECT 1 FROM "User" LIMIT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }
}
