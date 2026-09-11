/**
 * Loads the synthetic Phase 1 dataset for one user.
 *
 * Extracted from `seed.ts` so the demo pipeline (`scripts/seed-demo.ts`) can
 * reuse the exact dataset a developer gets locally, rather than keeping a
 * second copy that could drift from it.
 *
 * Deliberately *not* seeded here:
 *   * `Transaction.category` — rows land as UNCATEGORIZED so the Phase 3 rule
 *     engine and the Phase 4 LLM fallback have real work to do. The generator
 *     still knows the intended answer (`expectedCategory`), which is what the
 *     Phase 8 accuracy report scores against.
 *   * `Split`, `isDuplicateOf`, `linkedRefundId` — the raw import has no idea
 *     these relationships exist; discovering them is what Phases 2 and 3 build.
 *   * `AnomalyFlag`, `MonthlySummary`, `MerchantCategoryCache` — Phases 4, 6 and 7.
 *
 * The exception is the handful of rows demonstrating PROJECT_CONTEXT.md §8 case
 * 12: those are stored as MANUAL with their corrected category, alongside the
 * learned Rule each one produced, so later phases can prove a re-import and a
 * re-run of the engine leave a human's correction alone.
 */
import type { PrismaClient } from '../src/generated/prisma/client';
import { ensureDefaultRules } from '../src/services/rules/apply';
import { ACCOUNTS, DEMO_USER, generateDataset, transactionsByEdgeCase } from './seed-data';

export interface SeedResult {
  userId: string;
  email: string;
  accounts: string[];
  transactions: number;
  learnedRules: number;
  defaultRules: number;
  edgeCases: Map<string, unknown[]>;
}

function asDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Rebuilds the sample user from scratch. Repeated runs are idempotent: the
 * delete cascades from User through Account, Transaction and the learned Rules.
 */
export async function seedSyntheticDataset(
  prisma: PrismaClient,
  options: { email?: string; name?: string } = {},
): Promise<SeedResult> {
  const email = options.email ?? DEMO_USER.email;
  const dataset = generateDataset();

  await prisma.user.deleteMany({ where: { email } });

  const user = await prisma.user.create({
    data: {
      email,
      name: options.name ?? DEMO_USER.name,
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
      currency: 'INR',
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
  const defaultRules = (await ensureDefaultRules(prisma)).added;

  return {
    userId: user.id,
    email,
    accounts: user.accounts.map((a) => a.name),
    transactions: await prisma.transaction.count({ where: { account: { userId: user.id } } }),
    learnedRules: overrides.length,
    defaultRules,
    edgeCases: transactionsByEdgeCase(dataset),
  };
}
