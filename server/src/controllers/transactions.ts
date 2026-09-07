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

async function requireAccount(accountId: string) {
  const account = await getPrisma().account.findUnique({ where: { id: accountId } });
  if (!account) throw new HttpError(404, `No account with id "${accountId}"`);
  return account;
}

/**
 * POST /api/transactions/upload
 *
 * Returns a preview. Writes nothing.
 */
export const uploadTransactions: RequestHandler = async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Expected a CSV file in the "file" field');

  const { accountId, mapping } = uploadBodySchema.parse(req.body);
  await requireAccount(accountId);

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
  const { accountId, rows, resolutions } = commitBodySchema.parse(req.body);
  await requireAccount(accountId);

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
        currency: 'USD',
        category: 'UNCATEGORIZED' as const,
        confidence: 0,
        source: 'RULE' as const,
      })),
    });
  }

  res.status(201).json({
    accountId,
    imported: toImport.length,
    skipped: skipped.length,
  });
};
