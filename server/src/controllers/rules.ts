/**
 * The rules a user has taught the engine (Phase 20).
 *
 * Every accepted correction on the review page writes a learned rule, and
 * until now they were invisible: a mistaken correction kept recategorizing a
 * merchant on every import with nowhere to see why or undo it. Built-in rules
 * are not listed or editable here — they are shared by everyone and live in
 * `services/rules/defaults.ts`.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { resolvePayees } from '../services/payees/resolve';
import { applyRuleEngine } from '../services/rules/apply';
import { CATEGORIES } from '../services/rules/categories';

/**
 * The merchant a learned pattern stands for.
 *
 * Learned rules are written as `^<escaped merchant>$` by the override
 * endpoint, so the merchant is recoverable exactly. A pattern of any other
 * shape is shown as itself.
 */
export function merchantOfPattern(pattern: string): string | null {
  const match = /^\^(.*)\$$/.exec(pattern);
  if (!match) return null;
  return match[1].replace(/\\(.)/g, '$1');
}

/** GET /api/rules */
export const listRules: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);

  const rules = await getPrisma().rule.findMany({
    where: { userId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      pattern: true,
      category: true,
      learnedFromOverride: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // How many of the user's rows each rule is about. Matched on the merchant
  // key the rule was learned from, case-insensitively as the engine matches.
  const merchants = rules
    .map((rule) => merchantOfPattern(rule.pattern))
    .filter((m): m is string => m !== null);
  const counts = merchants.length
    ? await getPrisma().transaction.groupBy({
        by: ['normalizedMerchant'],
        where: {
          account: { userId },
          normalizedMerchant: { in: merchants, mode: 'insensitive' },
        },
        _count: { _all: true },
      })
    : [];
  const countOf = new Map<string, number>();
  for (const row of counts) {
    const key = row.normalizedMerchant.toUpperCase();
    countOf.set(key, (countOf.get(key) ?? 0) + row._count._all);
  }

  res.json({
    rules: rules.map((rule) => {
      const merchant = merchantOfPattern(rule.pattern);
      return {
        id: rule.id,
        pattern: rule.pattern,
        merchant,
        category: rule.category,
        learnedFromOverride: rule.learnedFromOverride,
        transactionCount: merchant ? (countOf.get(merchant.toUpperCase()) ?? 0) : null,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
      };
    }),
  });
};

async function ownedRule(userId: string, id: string) {
  const rule = await getPrisma().rule.findFirst({ where: { id, userId }, select: { id: true } });
  if (!rule) throw new HttpError(404, 'No such rule');
  return rule;
}

/**
 * Re-applies the engine after a rule changes, so the change is visible now
 * rather than at the next import. Rows a person set by hand are untouched by
 * that pass, exactly as on every other run.
 */
async function reapply(userId: string) {
  const categorization = await applyRuleEngine(getPrisma(), { userId });
  await resolvePayees(getPrisma(), { userId });
  return { recategorized: categorization.categorized };
}

const updateSchema = z.object({ category: z.enum(CATEGORIES) });

/** PATCH /api/rules/:id — change what a learned rule assigns. */
export const updateRule: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const id = z.string().min(1).parse(req.params.id);
  const { category } = updateSchema.parse(req.body);
  await ownedRule(userId, id);

  const rule = await getPrisma().rule.update({
    where: { id },
    data: { category },
    select: { id: true, pattern: true, category: true },
  });

  res.json({
    rule: { ...rule, merchant: merchantOfPattern(rule.pattern) },
    ...(await reapply(userId)),
  });
};

/**
 * DELETE /api/rules/:id
 *
 * Forgets the rule. The merchant's future rows fall back to the built-ins and
 * the model; the rows already corrected by hand stay as the person set them,
 * because deleting a rule is not the same as un-making a correction.
 */
export const deleteRule: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const id = z.string().min(1).parse(req.params.id);
  await ownedRule(userId, id);

  await getPrisma().rule.delete({ where: { id } });
  res.json(await reapply(userId));
};
