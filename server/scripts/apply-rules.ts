/**
 * Runs the deterministic categorization engine over everything already stored,
 * for the demo user. Useful after changing the rule set, and how the Phase 3
 * results in the pull request were produced.
 *
 * `npm run rules:apply --workspace server`
 */
import 'dotenv/config';

import { createPrismaClient } from '../src/db';
import { applyRuleEngine, ensureDefaultRules } from '../src/services/rules/apply';

const prisma = createPrismaClient();

async function main() {
  const email = process.env.SEED_USER_EMAIL ?? 'demo@fintrack.local';
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user with email ${email} — run \`npm run db:seed\` first`);

  const added = await ensureDefaultRules(prisma);
  if (added > 0) console.log(`Seeded ${added} built-in rules`);

  const summary = await applyRuleEngine(prisma, { userId: user.id });

  console.log(`Considered      ${summary.considered}`);
  console.log(`Recategorized   ${summary.categorized}`);
  console.log(`Transfer pairs  ${summary.transferPairs}`);
  console.log(`Refund links    ${summary.refundLinks}`);
  console.log(`Left manual     ${summary.manual}`);
  console.log(`UNCATEGORIZED   ${summary.uncategorized}`);
  console.log('\nBy category:');
  Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([category, count]) => {
      const share = ((count / summary.considered) * 100).toFixed(1);
      console.log(`  ${category.padEnd(18)} ${String(count).padStart(4)}  ${share}%`);
    });

  const resolved = summary.considered - summary.uncategorized;
  console.log(
    `\nResolved ${resolved}/${summary.considered} (${((resolved / summary.considered) * 100).toFixed(1)}%)`,
  );
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
