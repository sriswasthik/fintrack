/**
 * Upload and commit handlers for CSV import.
 *
 * The split is deliberate (IMPLEMENTATION_PLAN.md Phase 2): `upload` parses,
 * normalizes and flags duplicates but writes nothing, so the user sees exactly
 * what is about to happen; `commit` takes the reviewed rows plus the user's
 * keep/skip decisions and does the insert.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { LOW_CONFIDENCE_THRESHOLD } from '../services/ai/categorize';
import { monthWindow } from '../services/dashboard/window';
import { CATEGORIES } from '../services/rules/categories';
import { LEARNED_RULE_PRIORITY } from '../services/rules/defaults';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import {
  CsvMappingError,
  HEADER_PRESETS,
  detectPreset,
  inspectHeaders,
  parseTransactions,
  type ColumnMapping,
} from '../services/parsing/csv';
import { dateRangeOf, flagDuplicates, type ExistingTransaction } from '../services/parsing/dedup';
import { applyRuleEngine } from '../services/rules/apply';
import { scopeToUser } from './user-scope';

/** An explicit column mapping supplied by the client's mapping UI. */
const columnMappingSchema = z.object({
  date: z.string().min(1),
  description: z.string().min(1),
  amount: z.string().min(1),
  postedDate: z.string().min(1).optional(),
  amountSign: z.enum(['debit-positive', 'credit-positive']).default('debit-positive'),
});

const uploadBodySchema = z.object({
  accountId: z.string().min(1, 'accountId is required'),
  /** JSON-encoded, because the request is multipart/form-data. */
  mapping: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      try {
        return columnMappingSchema.parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'mapping must be a valid column mapping object' });
        return z.NEVER;
      }
    }),
});

const previewRowSchema = z.object({
  index: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  postedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .default(null),
  description: z.string().min(1),
  rawMerchant: z.string().min(1),
  normalizedMerchant: z.string(),
  amount: z.number().finite(),
});

const commitBodySchema = z.object({
  accountId: z.string().min(1),
  rows: z.array(previewRowSchema).min(1, 'No rows to import').max(20000),
  /** Row index -> what to do with it. Rows without an entry are kept. */
  resolutions: z.record(z.string(), z.enum(['keep', 'skip'])).default({}),
});

/**
 * The named account, provided it belongs to the caller.
 *
 * An account that exists but belongs to somebody else answers 404, not 403.
 * A 403 would confirm the id is real, which is enough to enumerate another
 * user's accounts one guess at a time; from outside, "not yours" and "not
 * there" should be indistinguishable.
 */
async function requireAccount(userId: string, accountId: string) {
  const account = await getPrisma().account.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new HttpError(404, `No account with id "${accountId}"`);
  return account;
}

/**
 * The `where` clause that ties a transaction to its owner.
 *
 * Every single-transaction route composes this rather than looking one up by
 * id alone, so "no such transaction" and "not yours" are the same answer.
 */
const ownedTransaction = (userId: string, id: string) => ({ id, account: { userId } });

const noSuchTransaction = () => new HttpError(404, 'No such transaction');

/**
 * POST /api/transactions/upload
 *
 * Returns a preview. Writes nothing.
 */
export const uploadTransactions: RequestHandler = async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Expected a CSV file in the "file" field');

  const userId = currentUserId(req);
  const { accountId, mapping } = uploadBodySchema.parse(req.body);
  await requireAccount(userId, accountId);

  const csvText = req.file.buffer.toString('utf8');
  if (!csvText.trim()) throw new HttpError(400, 'The uploaded file is empty');

  const { headers, sampleRows } = inspectHeaders(csvText);
  const preset = detectPreset(headers);
  const resolved: ColumnMapping | undefined = mapping ?? preset?.mapping;

  // Unknown layout and no mapping supplied: hand the headers back so the client
  // can put up a column-mapping UI and resubmit.
  if (!resolved) {
    res.json({
      status: 'needs-mapping',
      fileName: req.file.originalname,
      headers,
      sampleRows,
      requiredFields: ['date', 'description', 'amount'],
      knownPresets: HEADER_PRESETS.map((p) => ({ id: p.id, label: p.label, columns: p.required })),
    });
    return;
  }

  let parsed;
  try {
    parsed = parseTransactions(csvText, resolved);
  } catch (error) {
    if (error instanceof CsvMappingError) {
      throw new HttpError(400, error.message, { headers: error.headers });
    }
    throw error;
  }

  // Load only the transactions that could possibly match: same account, inside
  // the date span of the incoming file (widened by the dedup window).
  const range = dateRangeOf(parsed.rows);
  const existing: ExistingTransaction[] = range
    ? (
        await getPrisma().transaction.findMany({
          where: {
            accountId,
            date: {
              gte: new Date(`${range.from}T00:00:00.000Z`),
              lte: new Date(`${range.to}T00:00:00.000Z`),
            },
          },
          select: { id: true, date: true, amount: true, normalizedMerchant: true },
        })
      ).map((t) => ({
        id: t.id,
        date: t.date.toISOString().slice(0, 10),
        amount: Number(t.amount),
        normalizedMerchant: t.normalizedMerchant,
      }))
    : [];

  const rows = flagDuplicates(parsed.rows, existing);

  res.json({
    status: 'preview',
    fileName: req.file.originalname,
    accountId,
    preset: mapping ? 'custom' : (preset?.id ?? null),
    headers,
    mapping: resolved,
    totalRows: rows.length,
    duplicateCount: rows.filter((r) => r.duplicate).length,
    skippedRows: parsed.errors,
    rows,
  });
};

/**
 * POST /api/transactions/commit
 *
 * Inserts the reviewed rows. Categorization is Phase 3/4's job, so everything
 * lands as UNCATEGORIZED with zero confidence.
 */
export const commitTransactions: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { accountId, rows, resolutions } = commitBodySchema.parse(req.body);
  await requireAccount(userId, accountId);

  const skipped = rows.filter((row) => resolutions[String(row.index)] === 'skip');
  const toImport = rows.filter((row) => resolutions[String(row.index)] !== 'skip');

  if (toImport.length > 0) {
    await getPrisma().transaction.createMany({
      data: toImport.map((row) => ({
        accountId,
        date: new Date(`${row.date}T00:00:00.000Z`),
        postedDate: row.postedDate ? new Date(`${row.postedDate}T00:00:00.000Z`) : null,
        description: row.description,
        rawMerchant: row.rawMerchant,
        normalizedMerchant: row.normalizedMerchant,
        amount: row.amount.toFixed(2),
        currency: 'INR',
        category: 'UNCATEGORIZED' as const,
        confidence: 0,
        source: 'RULE' as const,
      })),
    });
  }

  // The deterministic pass runs immediately, before anything reaches the LLM
  // fallback (PROJECT_CONTEXT.md §4). It is scoped to the caller because
  // transfer pairing looks across their other accounts — and must never look
  // across anybody else's.
  const categorization = await applyRuleEngine(getPrisma(), { userId });

  res.status(201).json({
    accountId,
    imported: toImport.length,
    skipped: skipped.length,
    categorization,
  });
};

/** Express 5 types a route param as `string | string[]`; a single-segment id is always a string. */
function idParam(req: { params: Record<string, string | string[] | undefined> }): string {
  const value = req.params.id;
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'Missing transaction id');
  return value;
}

const listQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  /** YYYY-MM. Restricts the list to one calendar month, for dashboard drill-downs. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The shape the client renders. Decimals are serialized as numbers. */
function serializeTransaction(t: {
  id: string;
  accountId: string;
  date: Date;
  postedDate: Date | null;
  description: string;
  rawMerchant: string;
  normalizedMerchant: string;
  amount: unknown;
  currency: string;
  category: string;
  confidence: number;
  source: string;
  transferPairId: string | null;
  linkedRefundId: string | null;
  splits?: { id: string; category: string; amount: unknown; note: string | null }[];
}) {
  return {
    id: t.id,
    accountId: t.accountId,
    date: t.date.toISOString().slice(0, 10),
    postedDate: t.postedDate ? t.postedDate.toISOString().slice(0, 10) : null,
    description: t.description,
    rawMerchant: t.rawMerchant,
    normalizedMerchant: t.normalizedMerchant,
    amount: Number(t.amount),
    currency: t.currency,
    category: t.category,
    confidence: t.confidence,
    source: t.source,
    transferPairId: t.transferPairId,
    linkedRefundId: t.linkedRefundId,
    splits: (t.splits ?? []).map((s) => ({
      id: s.id,
      category: s.category,
      amount: Number(s.amount),
      note: s.note,
    })),
  };
}

/** GET /api/transactions */
export const listTransactions: RequestHandler = async (req, res) => {
  const { accountId, category, month, limit, offset } = listQuerySchema.parse(req.query);
  // Naming an account that is not yours is a 404, not an empty list: silently
  // dropping the filter would answer a question nobody asked.
  const userId = await scopeToUser(getPrisma(), req, accountId);

  const monthRange = month ? monthWindow(month) : null;
  const where = {
    // Ownership first, filters second. `accountId` narrows within the caller's
    // own accounts; it can never widen past them.
    account: { userId },
    ...(accountId ? { accountId } : {}),
    ...(category ? { category } : {}),
    ...(monthRange ? { date: { gte: monthRange.from, lt: monthRange.to } } : {}),
  };

  const [rows, total] = await Promise.all([
    getPrisma().transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset,
      include: { splits: true },
    }),
    getPrisma().transaction.count({ where }),
  ]);

  res.json({ total, limit, offset, transactions: rows.map(serializeTransaction) });
};

/** GET /api/transactions/:id */
export const getTransaction: RequestHandler = async (req, res) => {
  const transaction = await getPrisma().transaction.findFirst({
    where: ownedTransaction(currentUserId(req), idParam(req)),
    include: { splits: true },
  });
  if (!transaction) throw noSuchTransaction();
  res.json({ transaction: serializeTransaction(transaction) });
};

const splitBodySchema = z.object({
  splits: z
    .array(
      z.object({
        category: z.enum(CATEGORIES),
        amount: z.number().finite(),
        note: z.string().max(200).optional(),
      }),
    )
    // A single part is not a split — it is a recategorization, which is the
    // override endpoint's job in Phase 4.
    .min(2, 'A split needs at least two parts'),
});

/**
 * POST /api/transactions/:id/split
 *
 * Divides one charge across categories (§8 case 3). The parts must sum to the
 * transaction's total exactly, compared in whole cents — a split that loses or
 * invents money would quietly corrupt every aggregate built on top of it.
 */
export const splitTransaction: RequestHandler = async (req, res) => {
  const { splits } = splitBodySchema.parse(req.body);

  const transaction = await getPrisma().transaction.findFirst({
    where: ownedTransaction(currentUserId(req), idParam(req)),
    select: { id: true, amount: true },
  });
  if (!transaction) throw noSuchTransaction();

  const totalCents = Math.round(Number(transaction.amount) * 100);
  const splitCents = splits.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);

  if (splitCents !== totalCents) {
    throw new HttpError(400, 'Split amounts must sum to the transaction total', {
      transactionTotal: totalCents / 100,
      splitTotal: splitCents / 100,
      difference: (splitCents - totalCents) / 100,
    });
  }

  // Replacing rather than appending keeps the endpoint idempotent: posting a
  // corrected split twice leaves one set of parts, not two.
  await getPrisma().$transaction([
    getPrisma().split.deleteMany({ where: { transactionId: transaction.id } }),
    getPrisma().split.createMany({
      data: splits.map((s) => ({
        transactionId: transaction.id,
        category: s.category,
        amount: s.amount.toFixed(2),
        note: s.note ?? null,
      })),
    }),
  ]);

  const updated = await getPrisma().transaction.findUnique({
    where: { id: transaction.id },
    include: { splits: true },
  });

  res.status(201).json({ transaction: serializeTransaction(updated!) });
};

/** DELETE /api/transactions/:id/split */
export const clearSplit: RequestHandler = async (req, res) => {
  // Ownership is checked before the delete rather than folded into it: a
  // deleteMany that matched nothing would answer 200 with removed: 0, which
  // reads identically whether the transaction was unsplit or someone else's.
  const transaction = await getPrisma().transaction.findFirst({
    where: ownedTransaction(currentUserId(req), idParam(req)),
    select: { id: true },
  });
  if (!transaction) throw noSuchTransaction();

  const { count } = await getPrisma().split.deleteMany({
    where: { transactionId: transaction.id },
  });
  res.json({ removed: count });
};

/** POST /api/transactions/categorize — re-runs the deterministic pass. */
export const categorizeTransactions: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { accountId } = z.object({ accountId: z.string().min(1) }).parse(req.body);
  await requireAccount(userId, accountId);

  res.json(await applyRuleEngine(getPrisma(), { userId }));
};

const reviewQueueQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/review-queue
 *
 * Everything a human still needs to look at: transactions no pass could resolve,
 * plus AI answers the model itself was not confident about. A rule match is
 * never here — those are deterministic and certain by construction.
 */
export const getReviewQueue: RequestHandler = async (req, res) => {
  const { accountId, limit, offset } = reviewQueueQuerySchema.parse(req.query);
  const userId = await scopeToUser(getPrisma(), req, accountId);

  /** Owner first, then the optional account filter within their own accounts. */
  const mine = { account: { userId }, ...(accountId ? { accountId } : {}) };

  const where = {
    ...mine,
    OR: [
      { category: 'UNCATEGORIZED' as const },
      { source: 'LLM' as const, confidence: { lt: LOW_CONFIDENCE_THRESHOLD } },
    ],
  };

  const [rows, total, uncategorized, lowConfidence] = await Promise.all([
    getPrisma().transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset,
      include: { splits: true },
    }),
    getPrisma().transaction.count({ where }),
    getPrisma().transaction.count({ where: { ...mine, category: 'UNCATEGORIZED' } }),
    getPrisma().transaction.count({
      where: { ...mine, source: 'LLM', confidence: { lt: LOW_CONFIDENCE_THRESHOLD } },
    }),
  ]);

  res.json({
    total,
    limit,
    offset,
    counts: { uncategorized, lowConfidence },
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    transactions: rows.map(serializeTransaction),
  });
};

const categoryOverrideSchema = z.object({
  category: z.enum(CATEGORIES),
  /**
   * Whether to remember this for the merchant. On by default — teaching the
   * system is the point of reviewing.
   */
  learn: z.boolean().default(true),
});

/**
 * POST /api/transactions/:id/category
 *
 * A human's correction. Three things happen, and all three matter:
 *
 *   1. The transaction is stored MANUAL at full confidence, which every later
 *      pass is required to leave alone (PROJECT_CONTEXT.md §7).
 *   2. A learned Rule is written for the merchant at a priority above every
 *      built-in, so future imports of the same merchant are categorized by rule
 *      and never reach the LLM at all.
 *   3. The correction is recorded in `CategoryOverride` — who, when, from what
 *      to what — because a person disagreeing with the engine is the only
 *      signal that says the engine was wrong.
 *
 * What deliberately does *not* happen any more is a write to
 * `MerchantCategoryCache`. That table is keyed by merchant alone and shared by
 * every user (PROJECT_CONTEXT.md §7), which is right for a model's opinion
 * about what a merchant sells and wrong for one person's private preference:
 * it would make one user's correction everybody's default, and let a stranger
 * infer that somebody had categorized that merchant. The learned Rule below
 * already guarantees this user never sees the wrong answer again, because a
 * rule match runs before the LLM path is reached at all.
 */
export const overrideCategory: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const { category, learn } = categoryOverrideSchema.parse(req.body);
  const transactionId = idParam(req);

  const transaction = await getPrisma().transaction.findFirst({
    where: ownedTransaction(userId, transactionId),
    select: { id: true, normalizedMerchant: true, category: true },
  });
  if (!transaction) throw noSuchTransaction();

  const merchant = transaction.normalizedMerchant;
  const previousCategory = transaction.category;

  await getPrisma().transaction.update({
    where: { id: transactionId },
    data: { category, confidence: 1, source: 'MANUAL' },
  });

  let rule = null;
  if (learn && merchant) {
    // Anchored so the rule matches this merchant and not merely anything
    // containing it, and escaped so a merchant with regex characters in its
    // name cannot become a pattern that matches half the account.
    const pattern = `^${escapeRegExp(merchant)}$`;
    const existing = await getPrisma().rule.findFirst({ where: { userId, pattern } });

    rule = existing
      ? await getPrisma().rule.update({
          where: { id: existing.id },
          data: { category, learnedFromOverride: true, priority: LEARNED_RULE_PRIORITY },
        })
      : await getPrisma().rule.create({
          data: {
            userId,
            pattern,
            category,
            priority: LEARNED_RULE_PRIORITY,
            learnedFromOverride: true,
          },
        });
  }

  await getPrisma().categoryOverride.create({
    data: {
      userId,
      transactionId,
      merchant,
      fromCategory: previousCategory,
      toCategory: category,
      learnedRule: rule !== null,
    },
  });

  const updated = await getPrisma().transaction.findUnique({
    where: { id: transactionId },
    include: { splits: true },
  });

  res.json({
    transaction: serializeTransaction(updated!),
    learnedRule: rule ? { id: rule.id, pattern: rule.pattern, category: rule.category } : null,
  });
};

/** Escapes a string so it can be embedded in a regular expression literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
