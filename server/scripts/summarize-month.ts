/**
 * Generates (or reads) the monthly recap for the demo user and prints it, with
 * the figures it was written from and what the call cost.
 *
 * `npm run summary:month --workspace server -- 2026-06`
 * `npm run summary:month --workspace server -- 2026-06 --regenerate`
 */
import 'dotenv/config';

import { createPrismaClient } from '../src/db';
import { AnthropicMonthlySummarizer } from '../src/services/ai/summarize';
import { getMonthlySummary, regenerateMonthlySummary } from '../src/services/summary/apply';
import { toIsoMonth } from '../src/services/dashboard/window';

const prisma = createPrismaClient();

async function main() {
  const email = process.env.SEED_USER_EMAIL ?? 'demo@fintrack.local';
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user with email ${email} — run \`npm run db:seed\` first`);

  const month = process.argv.find((arg) => /^\d{4}-\d{2}$/.test(arg)) ?? toIsoMonth(new Date());
  const regenerate = process.argv.includes('--regenerate');

  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const summarizer = new AnthropicMonthlySummarizer({
    onUsage: (usage) => {
      calls += 1;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    },
  });

  const record = regenerate
    ? await regenerateMonthlySummary(prisma, summarizer, { userId: user.id, month })
    : await getMonthlySummary(prisma, summarizer, { userId: user.id, month });

  console.log(`${record.stats.monthLabel}`);
  console.log('-'.repeat(record.stats.monthLabel.length));
  console.log(record.content);
  console.log();
  console.log(`source        ${record.source}${record.cached ? ' (from cache)' : ''}`);
  if (record.stale)
    console.log('stale         yes — the figures have moved since this was written');
  if (record.unavailable) console.log(`unavailable   ${record.unavailable}`);
  console.log(`model calls   ${calls}`);
  if (calls > 0) console.log(`tokens        ${inputTokens} in / ${outputTokens} out`);
  console.log();
  console.log('Figures it was written from:');
  console.log(JSON.stringify(record.stats, null, 2));
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
