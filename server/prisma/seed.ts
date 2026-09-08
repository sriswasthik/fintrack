/**
 * Seeds the demo user, two accounts and the synthetic transaction set.
 *
 * Run with `npx prisma db seed` from `server/` (wired up in prisma.config.ts).
 *
 * Deliberately *not* seeded here:
 *   * `Transaction.category` — rows land as UNCATEGORIZED so the Phase 3 rule
 *     engine and the Phase 4 LLM fallback have real work to do. The generator
 *     still knows the intended answer (`expectedCategory`), which is what the
 *     Phase 8 accuracy report will score against.
 *   * `Split`, `isDuplicateOf`, `linkedRefundId` — the raw import has no idea
 *     these relationships exist; discovering them is what Phases 2 and 3 build.
 *   * `AnomalyFlag`, `MonthlySummary`, `MerchantCategoryCache` — Phases 4, 6 and 7.
 *
 * The exception is the handful of rows demonstrating PROJECT_CONTEXT.md §8 case
 * 12: those are stored as MANUAL with their corrected category, alongside the
 * learned Rule each one produced, so later phases can prove a re-import and a
 * re-run of the engine leave a human's correction alone.
 */
import 'dotenv/config';

import { createPrismaClient } from '../src/db';
import { ensureDefaultRules } from '../src/services/rules/apply';
import {
  ACCOUNTS,
  DEMO_USER,
  REFERENCE_DATE,
  START_DATE,
  generateDataset,
  transactionsByEdgeCase,
} from './seed-data';

const prisma = createPrismaClient();

function asDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function main() {
  const dataset = generateDataset();

  // Rebuild from scratch so repeated runs are idempotent. Cascades from User
  // clear Account -> Transaction and the user's learned Rules.
  await prisma.user.deleteMany({ where: { email: DEMO_USER.email } });

  const user = await prisma.user.create({
    data: {
      email: DEMO_USER.email,
      name: DEMO_USER.name,
      passwordHash: DEMO_USER.passwordHash,
      accounts: {
        create: [
          { name: ACCOUNTS.checking.name, type: ACCOUNTS.checking.type },
          { name: ACCOUNTS.credit.name, type: ACCOUNTS.credit.type },
        ],
      },
    },
    include: { accounts: true },
  });

  const accountId = new Map(user.accounts.map((a) => [a.name, a.id]));
  const checkingId = accountId.get(ACCOUNTS.checking.name)!;
  const creditId = accountId.get(ACCOUNTS.credit.name)!;

  await prisma.transaction.createMany({
    data: dataset.map((t) => ({
      accountId: t.account === 'checking' ? checkingId : creditId,
      date: asDate(t.date),
      postedDate: t.postedDate ? asDate(t.postedDate) : null,
      description: t.description,
      rawMerchant: t.rawMerchant,
      normalizedMerchant: t.normalizedMerchant,
      amount: t.amount.toFixed(2),
      currency: 'USD',
      // §8 case 12 rows keep the correction a human already made; everything
      // else is left for the categorization phases.
      ...(t.manualCategory
        ? { category: t.manualCategory, source: 'MANUAL' as const, confidence: 1 }
        : {}),
    })),
  });

  // The learned rules those manual corrections produced (§8 case 12).
  const overrides = dataset.filter((t) => t.manualCategory);
  await prisma.rule.createMany({
    data: overrides.map((t) => ({
      userId: user.id,
      pattern: t.normalizedMerchant,
      category: t.manualCategory!,
      // Below the Phase 3 built-ins (default priority 100) so a human always wins.
      priority: 10,
      learnedFromOverride: true,
    })),
  });

  // The Phase 3 built-in rule set. Seeded here so a fresh database can run the
  // deterministic engine straight away.
  const seededRules = await ensureDefaultRules(prisma);

  const total = await prisma.transaction.count();
  const byCase = transactionsByEdgeCase(dataset);

  console.log(`Seeded ${total} transactions for ${DEMO_USER.email}`);
  console.log(`  window        ${START_DATE} .. ${REFERENCE_DATE}`);
  console.log(`  accounts      ${user.accounts.map((a) => a.name).join(', ')}`);
  console.log(`  learned rules ${overrides.length}`);
  console.log(`  default rules ${seededRules}`);
  console.log('  edge cases:');
  [...byCase.entries()]
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
