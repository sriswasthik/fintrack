/**
 * Prepares the account demo mode hands out (`POST /api/auth/demo`).
 *
 * `npm run demo:seed --workspace server`
 *
 * The plain `db:seed` deliberately stops at raw imported rows, because the
 * categorization phases are supposed to have work to do. A portfolio visitor
 * arriving at the deployed URL has no such patience, so this runs the whole
 * pipeline to completion and leaves an account that already looks lived-in:
 * categorized transactions, anomaly flags, and a written recap per month.
 *
 * Summaries are generated here, once, at deploy time rather than on the first
 * visit. That is what keeps demo mode free to run: the read-only session can
 * never trigger a model call, because every month it can navigate to already
 * has one cached.
 */
import 'dotenv/config';

import { seedSyntheticDataset } from '../prisma/seed-dataset';
import { createPrismaClient } from '../src/db';
import { AnthropicMonthlySummarizer } from '../src/services/ai/summarize';
import { refreshAnomalies } from '../src/services/anomalies/apply';
import { demoUserEmail } from '../src/services/auth/demo';
import { applyRuleEngine } from '../src/services/rules/apply';
import { getMonthlySummary } from '../src/services/summary/apply';

const prisma = createPrismaClient();

/** Every YYYY-MM from `first` to `last` inclusive. */
function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  const [year, index] = first.split('-').map(Number);
  for (let step = 0; ; step++) {
    const month = new Date(Date.UTC(year, index - 1 + step, 1)).toISOString().slice(0, 7);
    if (month > last) break;
    months.push(month);
  }
  return months;
}

async function main() {
  const email = demoUserEmail();
  console.log(`Rebuilding the demo account (${email})`);

  const seeded = await seedSyntheticDataset(prisma, { email, name: 'Demo User' });
  console.log(`  transactions   ${seeded.transactions}`);
  console.log(`  accounts       ${seeded.accounts.join(', ')}`);

  const { userId } = seeded;

  const categorized = await applyRuleEngine(prisma, { userId });
  console.log(
    `  categorized    ${categorized.categorized} (${categorized.uncategorized} left for review)`,
  );

  const span = await prisma.transaction.aggregate({
    where: { account: { userId } },
    _min: { date: true },
    _max: { date: true },
  });
  if (!span._min.date || !span._max.date) throw new Error('Seeded no transactions to analyse');

  const months = monthsBetween(
    span._min.date.toISOString().slice(0, 7),
    span._max.date.toISOString().slice(0, 7),
  );

  let flags = 0;
  for (const month of months) {
    const found = await refreshAnomalies(prisma, { userId, month });
    flags += found.created;
  }
  console.log(`  anomaly flags  ${flags} across ${months.length} months`);

  // One model call per month, at deploy time. Without a key the summarizer
  // degrades to the deterministic stats paragraph rather than failing, so a
  // demo can be seeded on a machine that has no Anthropic credentials.
  let calls = 0;
  const summarizer = new AnthropicMonthlySummarizer({ onUsage: () => (calls += 1) });
  const sources = new Map<string, number>();
  for (const month of months) {
    const record = await getMonthlySummary(prisma, summarizer, { userId, month });
    sources.set(record.source, (sources.get(record.source) ?? 0) + 1);
  }
  const written = [...sources.entries()].map(([source, n]) => `${n} ${source}`).join(', ');
  console.log(`  summaries      ${written} (${calls} model calls)`);

  console.log('\nDone. Set DEMO_MODE=on so POST /api/auth/demo will serve it.');
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
