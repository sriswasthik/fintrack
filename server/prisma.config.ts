import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Read directly rather than via prisma/config's `env()` helper: that helper
    // throws when the variable is missing, which would break `prisma generate`
    // in CI, where there is no .env and no database. Commands that actually
    // connect still fail loudly, and src/db.ts explains what to set.
    url: process.env['DATABASE_URL'],
  },
});
