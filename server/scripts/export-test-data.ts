/**
 * Writes test-data/synthetic_transactions.csv and test-data/README.md from the
 * same generator the database seed uses, so the flat file, the seeded rows and
 * the row numbers quoted in the README can never drift apart.
 *
 * Run with `npm run test-data:export --workspace server`.
 * `prisma/seed-data.test.ts` fails if the committed files are out of date.
 */
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { buildCsv, buildReadme } from '../prisma/test-data-files';

const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(repoRoot, 'test-data');

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'synthetic_transactions.csv'), buildCsv(), 'utf8');
writeFileSync(path.join(outDir, 'README.md'), buildReadme(), 'utf8');

console.log(`Wrote ${path.relative(repoRoot, path.join(outDir, 'synthetic_transactions.csv'))}`);
console.log(`Wrote ${path.relative(repoRoot, path.join(outDir, 'README.md'))}`);
