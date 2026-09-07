/**
 * Prisma client wiring.
 *
 * Prisma 7 no longer talks to the database itself — it needs a driver adapter,
 * so the connection string is handed to `@prisma/adapter-pg` here rather than
 * being read out of schema.prisma.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client';

export function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — copy server/.env.example to server/.env');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

let client: PrismaClient | undefined;

/**
 * Lazily created singleton for request handling. Constructed on first use so
 * importing this module never fails when the database is not configured.
 */
export function getPrisma(): PrismaClient {
  client ??= createPrismaClient();
  return client;
}
