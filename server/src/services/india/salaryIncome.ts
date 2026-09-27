/**
 * Salary credits, categorized as income.
 *
 * The built-in rules recognise a salary by its words — SALARY, PAYROLL, DIRECT
 * DEP — and an Indian NEFT salary credit usually has none of them: it names the
 * employer and nothing else ("NEFT CR-…-NORTHWIND LABS-…"). Left alone, that
 * credit sits in the review queue every month.
 *
 * The salary detector (`salary.ts`) already knows a salary by its behaviour:
 * the same payer, three consecutive months, amounts within 10%, the same pay
 * day. Whatever payer it finds in any month of a person's history, that payer's
 * uncategorized credits are income. It is deliberately a narrow pass:
 *
 *   * Only rows the rules left UNCATEGORIZED are changed. A person's own
 *     correction, and anything a rule settled, is never revisited.
 *   * Transfers and refunds are not evidence: a standing transfer between
 *     your own accounts is regular too, and it is not income.
 *   * A payer who reads as a person is left alone. A relative sending the
 *     same amount every month is regular, but what that money is — support,
 *     rent, a loan being repaid — is for the person to say.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { classifyCounterparty } from '../rules/counterparty';
import { detectSalary } from './salary';
import { monthOf, type IndiaTransaction } from './types';

export interface SalaryIncomeSummary {
  /** Payers recognised as a salary in at least one month. */
  payers: string[];
  /** Credits moved from UNCATEGORIZED to INCOME by this pass. */
  categorized: number;
}

/** A rule settles with certainty; a pattern read from the statement, a shade less. */
const SALARY_CONFIDENCE = 0.9;

export async function categorizeSalaryCredits(
  prisma: PrismaClient,
  { userId }: { userId: string },
): Promise<SalaryIncomeSummary> {
  const rows = await prisma.transaction.findMany({
    where: { account: { userId }, category: { notIn: ['TRANSFER', 'REFUND'] } },
    select: {
      id: true,
      date: true,
      amount: true,
      category: true,
      normalizedMerchant: true,
      counterpartyRaw: true,
      upiVpa: true,
    },
    orderBy: { date: 'asc' },
  });
  if (rows.length === 0) return { payers: [], categorized: 0 };

  const transactions: IndiaTransaction[] = rows.map((row) => ({
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    amount: Number(row.amount),
    category: row.category,
    normalizedMerchant: row.normalizedMerchant,
  }));

  // A salary that ran from March to May and stopped is still a salary for
  // those months, so every month is asked, not just the latest.
  const payers = new Set<string>();
  for (const month of new Set(transactions.map((t) => monthOf(t.date)))) {
    const salary = detectSalary(transactions, { month });
    if (salary) payers.add(salary.payer);
  }

  const people = new Set(
    rows
      .filter((row) => payers.has(row.normalizedMerchant))
      .filter((row) => classifyCounterparty(row).type === 'PERSON')
      .map((row) => row.normalizedMerchant),
  );
  const employers = [...payers].filter((payer) => !people.has(payer)).sort();
  if (employers.length === 0) return { payers: [], categorized: 0 };

  const { count } = await prisma.transaction.updateMany({
    where: {
      account: { userId },
      normalizedMerchant: { in: employers },
      amount: { lt: 0 },
      category: 'UNCATEGORIZED',
      source: 'RULE',
    },
    data: { category: 'INCOME', confidence: SALARY_CONFIDENCE },
  });

  return { payers: employers, categorized: count };
}
