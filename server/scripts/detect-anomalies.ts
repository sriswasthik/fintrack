/**
 * Runs anomaly detection over everything stored for the demo user, one month at
 * a time, and prints what it found. How the Phase 6 results in the pull request
 * were produced.
 *
 * `npm run anomalies:detect --workspace server`
 * `npm run anomalies:detect --workspace server -- 2026-05`
 */
import 'dotenv/config';

import { createPrismaClient } from '../src/db';
import { listInsights, refreshAnomalies } from '../src/services/anomalies/apply';

const prisma = createPrismaClient();

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
  const email = process.env.SEED_USER_EMAIL ?? 'demo@fintrack.local';
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user with email ${email} — run \`npm run db:seed\` first`);

  const requested = process.argv[2];
  const span = await prisma.transaction.aggregate({
    where: { account: { userId: user.id } },
    _min: { date: true },
    _max: { date: true },
  });
  if (!span._min.date || !span._max.date) throw new Error('No transactions to analyse');

  const months = requested
    ? [requested]
    : monthsBetween(
        span._min.date.toISOString().slice(0, 7),
        span._max.date.toISOString().slice(0, 7),
      );

  let total = 0;

  for (const month of months) {
    const summary = await refreshAnomalies(prisma, { userId: user.id, month });
    const insights = await listInsights(prisma, { userId: user.id, month });
    total += insights.length;

    console.log(
      `\n${month}  ${summary.detected} detected  (${summary.created} new, ${summary.updated} refreshed, ${summary.cleared} cleared)`,
    );
    insights.forEach((insight) => {
      console.log(`  [${insight.severity.padEnd(6)}] ${insight.type}`);
      console.log(`           ${insight.explanation}`);
    });
  }

  console.log(`\n${total} active insight(s) across ${months.length} month(s).`);
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
