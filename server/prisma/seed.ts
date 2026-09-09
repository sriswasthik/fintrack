/**
 * Seeds the sample user, two accounts and the synthetic transaction set.
 *
 * Run with `npx prisma db seed` from `server/` (wired up in prisma.config.ts).
 * The dataset itself lives in `seed-dataset.ts`, which the deployed demo
 * pipeline (`npm run demo:seed`) reuses so the two can never drift apart.
 */
import 'dotenv/config';

import { createPrismaClient } from '../src/db';
import { REFERENCE_DATE, START_DATE } from './seed-data';
import { seedSyntheticDataset } from './seed-dataset';

const prisma = createPrismaClient();

async function main() {
  const result = await seedSyntheticDataset(prisma);

  console.log(`Seeded ${result.transactions} transactions for ${result.email}`);
  console.log(`  window        ${START_DATE} .. ${REFERENCE_DATE}`);
  console.log(`  accounts      ${result.accounts.join(', ')}`);
  console.log(`  learned rules ${result.learnedRules}`);
  console.log(`  default rules ${result.defaultRules}`);
  console.log('  edge cases:');
  [...result.edgeCases.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .forEach(([name, rows]) => console.log(`    ${name.padEnd(28)} ${rows.length}`));
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
