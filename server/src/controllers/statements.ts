/**
 * PDF statement import.
 *
 * Two endpoints, because the password question has to be answered before it is
 * asked. `/inspect` looks at the file and says whether it is encrypted;
 * `/parse` does the reading. Most statements are not encrypted, and putting a
 * password box in front of someone who does not need one is a box they will
 * assume they are failing at.
 *
 * Everything after the text comes out is the pipeline Phases 2 and 3 already
 * built: the same rows, the same normalization, the same duplicate flagging,
 * and the same `/transactions/commit` to persist them. This controller returns
 * the identical preview envelope the CSV upload does, so the client's confirm
 * step and the commit route needed no changes at all.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { getPrisma } from '../db';
import { currentUserId } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { redactStatementText } from '../services/ai/redact';
import {
  AnthropicStatementReader,
  StatementReaderConfigurationError,
  StatementReaderResponseError,
  type StatementReader,
} from '../services/ai/statement';
import {
  parseWithAdapter,
  type NormalizedRow,
  type SourceId,
} from '../services/parsing/bankAdapters';
import {
  dateRangeOf,
  flagDuplicates,
  type ExistingTransaction,
  type FlaggedRow,
} from '../services/parsing/dedup';
import {
  extractPdfText,
  IncorrectPasswordError,
  inspectPdf,
  PasswordRequiredError,
  UnreadablePdfError,
} from '../services/parsing/pdf';
import { groupIntoLines, parseGenericStatement, toPlainText } from '../services/parsing/statement';
import {
  detectMapping,
  inspectHeaders,
  parseTransactions,
  type ParsedRow,
} from '../services/parsing/csv';
import {
  isSpreadsheet,
  tableToCsv,
  UnreadableSpreadsheetError,
} from '../services/parsing/spreadsheet';

const parseBodySchema = z.object({
  accountId: z.string().min(1, 'accountId is required'),
  /** Only meaningful for an encrypted file; ignored otherwise. */
  password: z.string().min(1).optional(),
});

let reader: StatementReader | undefined;

/**
 * Lazily built, like the summarizer: importing this module must not fail on a
 * server with no API key. Only actually falling back does.
 */
function getReader(): StatementReader {
  reader ??= new AnthropicStatementReader();
  return reader;
}

/** Test seam, so a route test never reaches the network. */
export function setStatementReader(next: StatementReader | undefined): void {
  reader = next;
}

async function requireAccount(userId: string, accountId: string) {
  const account = await getPrisma().account.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new HttpError(404, `No account with id "${accountId}"`);
  return account;
}

function requirePdf(file: Express.Multer.File | undefined): Buffer {
  if (!file) throw new HttpError(400, 'Expected a PDF file in the "file" field');
  if (file.size === 0) throw new HttpError(400, 'The uploaded file is empty');
  return file.buffer;
}

/**
 * POST /api/statements/inspect — does this file need a password?
 *
 * Answers only that. No account id, no parsing, nothing written: the client
 * calls it the moment a file is chosen, to decide whether to show a password
 * field at all.
 */
export const inspectStatement: RequestHandler = async (req, res) => {
  currentUserId(req);
  const buffer = requirePdf(req.file);

  try {
    const { requiresPassword } = await inspectPdf(buffer);
    res.json({ fileName: req.file?.originalname ?? null, requiresPassword });
  } catch (error) {
    if (error instanceof UnreadablePdfError) throw new HttpError(400, error.message);
    throw error;
  }
};

/** Everything reading one statement produced. */
interface ReadStatement {
  rows: NormalizedRow[];
  errors: { index: number; reason: string; values: Record<string, string> }[];
  /** Which adapter claimed it, or 'unknown' when none did. */
  source: SourceId;
  sourceLabel: string;
  /** How it was actually read, which is not the same question. */
  via: 'adapter' | 'layout' | 'model';
  pages: number;
  confidence: number | null;
  modelCalls: number;
}

/**
 * Reads one statement, trying each reader in turn.
 *
 *   1. A bank adapter that recognises the format and knows its quirks.
 *   2. The Phase 12 geometric reader, for a tabular layout nobody claimed.
 *   3. The model, for anything else.
 *
 * The order is the order of confidence, not of cleverness: an adapter knows
 * that SBI prints credits in the debit column, the geometric reader can only
 * see that there is one money column, and the model is guessing from prose.
 */
async function readStatement(buffer: Buffer, password: string | undefined): Promise<ReadStatement> {
  const pages = await extractPdfText(buffer, password);
  const lines = pages.flatMap((page) => groupIntoLines(page));
  const rawText = toPlainText(pages);

  const viaAdapter = parseWithAdapter({ rawText, lines, pages });
  if (viaAdapter) {
    return {
      rows: viaAdapter.rows,
      errors: [],
      source: viaAdapter.source,
      sourceLabel: viaAdapter.label,
      via: 'adapter',
      pages: pages.length,
      confidence: 1,
      modelCalls: 0,
    };
  }

  const generic = parseGenericStatement(pages);
  if (generic) {
    return {
      rows: generic.rows,
      errors: generic.errors,
      source: 'unknown',
      sourceLabel: 'Generic tabular statement',
      via: 'layout',
      pages: pages.length,
      confidence: generic.confidence,
      modelCalls: 0,
    };
  }

  if (!rawText.trim()) {
    throw new HttpError(
      400,
      'No text could be read from this PDF. It may be a scan of a paper statement.',
      { reason: 'no-text' },
    );
  }

  if (process.env.AI_STATEMENT_READER === 'off') {
    throw new HttpError(
      422,
      "This statement's layout is not one we read directly, and reading it with AI is switched off on this server.",
      { reason: 'unsupported-layout' },
    );
  }

  // Only the transaction table goes to the model, with identifiers masked —
  // never the name, address and account number above it (services/ai/redact.ts).
  const { text: forModel } = redactStatementText(rawText);
  if (!forModel) {
    throw new HttpError(422, 'No transactions could be found in this statement.', {
      reason: 'unreadable-layout',
    });
  }

  try {
    const read = await getReader().read(forModel);
    return {
      rows: read.rows,
      errors: read.errors,
      source: 'unknown',
      sourceLabel: 'Read by the fallback reader',
      via: 'model',
      pages: pages.length,
      confidence: null,
      modelCalls: read.calls,
    };
  } catch (error) {
    if (error instanceof StatementReaderConfigurationError) {
      console.warn(`Statement reader unavailable: ${error.message}`);
      throw new HttpError(
        422,
        "This statement's layout is not one we read directly, and the fallback reader is not configured on this server.",
        { reason: 'unsupported-layout' },
      );
    }
    if (error instanceof StatementReaderResponseError) {
      throw new HttpError(422, `This statement could not be read: ${error.message}`, {
        reason: 'unreadable-layout',
      });
    }
    throw error;
  }
}

/** A PDF says so in its first bytes, whatever it is called. */
function isPdfFile(buffer: Buffer, fileName: string): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-' || /\.pdf$/i.test(fileName);
}

/**
 * Reads a CSV or Excel export in a batch, through the same path a single one
 * takes — with one difference: a single upload whose columns are not
 * recognised asks the person to map them, and a batch has nowhere to ask. That
 * file comes back as failed, saying so, and the rest of the batch goes on.
 */
function readTable(buffer: Buffer, fileName: string) {
  let csvText: string;
  try {
    csvText = tableToCsv(buffer, fileName);
  } catch (error) {
    if (error instanceof UnreadableSpreadsheetError) {
      throw new HttpError(422, error.message, { reason: 'unreadable-table' });
    }
    throw error;
  }

  const detected = detectMapping(inspectHeaders(csvText).headers);
  if (!detected) {
    throw new HttpError(
      422,
      'Its columns were not recognised. Import this file on its own to map them.',
      { reason: 'needs-mapping' },
    );
  }

  const parsed = parseTransactions(csvText, detected.mapping);
  const kind = isSpreadsheet(buffer, fileName) ? 'Excel' : 'CSV';
  return {
    rows: parsed.rows,
    errors: parsed.errors,
    sourceLabel: `${kind} — ${detected.label}`,
    // The batch preview has no per-file switch to flip, so it says the guess out loud.
    note:
      parsed.dateOrder.basis === 'default'
        ? 'Dates were read day first (03/05 is 3 May); nothing in the file proved it either way.'
        : undefined,
  };
}

/** Turns a PDF-reading failure into the response the client can act on. */
function asHttpError(error: unknown): HttpError | null {
  if (error instanceof PasswordRequiredError) {
    return new HttpError(
      400,
      'This statement is password-protected. Enter its password to continue.',
      { reason: 'password-required' },
    );
  }
  if (error instanceof IncorrectPasswordError) {
    return new HttpError(400, 'That password did not open the statement. Check it and try again.', {
      reason: 'incorrect-password',
    });
  }
  if (error instanceof UnreadablePdfError) {
    return new HttpError(400, error.message, { reason: 'unreadable' });
  }
  return error instanceof HttpError ? error : null;
}

/** The rows already on the account that could possibly match what is incoming. */
async function existingNear(
  accountId: string,
  rows: { date: string }[],
): Promise<ExistingTransaction[]> {
  const range = dateRangeOf(rows as NormalizedRow[]);
  if (!range) return [];

  const stored = await getPrisma().transaction.findMany({
    where: {
      accountId,
      date: {
        gte: new Date(`${range.from}T00:00:00.000Z`),
        lte: new Date(`${range.to}T00:00:00.000Z`),
      },
    },
    select: { id: true, date: true, amount: true, normalizedMerchant: true },
  });

  return stored.map((t) => ({
    id: t.id,
    date: t.date.toISOString().slice(0, 10),
    amount: Number(t.amount),
    normalizedMerchant: t.normalizedMerchant,
  }));
}

/**
 * POST /api/statements/parse — read the statement into a preview.
 *
 * The two password failures are answered differently on purpose. "This file
 * needs a password" and "that password was wrong" send a person to different
 * next actions, and answering the second with the first is how somebody ends up
 * typing the same wrong password three times.
 */
export const parseStatement: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const buffer = requirePdf(req.file);
  const { accountId, password } = parseBodySchema.parse(req.body);
  await requireAccount(userId, accountId);

  let read: ReadStatement;
  try {
    read = await readStatement(buffer, password);
  } catch (error) {
    const http = asHttpError(error);
    if (http) throw http;
    throw error;
  }

  if (read.rows.length === 0) {
    throw new HttpError(400, 'No transactions were found in this statement.', {
      reason: 'no-rows',
    });
  }

  const rows = flagDuplicates(read.rows, await existingNear(accountId, read.rows));

  // Deliberately the same envelope the CSV upload returns, so the client's
  // confirm screen and POST /transactions/commit work unchanged.
  res.json({
    status: 'preview',
    fileName: req.file?.originalname ?? null,
    accountId,
    preset: read.via === 'adapter' ? `pdf-${read.source}` : `pdf-${read.via}`,
    source: read.source,
    sourceLabel: read.sourceLabel,
    via: read.via,
    modelCalls: read.modelCalls,
    pages: read.pages,
    confidence: read.confidence,
    totalRows: rows.length,
    duplicateCount: rows.filter((r) => r.duplicate).length,
    skippedRows: read.errors,
    rows,
  });
};

// ---------------------------------------------------------------------------
// Batch import — a quarter, or any range, across several files at once
// ---------------------------------------------------------------------------

const batchBodySchema = z.object({
  accountId: z.string().min(1, 'accountId is required'),
  /**
   * Passwords by file position, as JSON: `{"1": "hunter2"}`.
   *
   * Keyed by position rather than by filename because two files chosen in one
   * go can share a name, and a password applied to the wrong file is a failed
   * import that looks like a wrong password.
   */
  passwords: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return {} as Record<string, string>;
      try {
        const parsed: unknown = JSON.parse(value);
        return z.record(z.string(), z.string()).parse(parsed);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'passwords must be a JSON object' });
        return z.NEVER;
      }
    }),
});

/** What happened to one file in the batch. */
type FileStatus = 'parsed' | 'needs-password' | 'wrong-password' | 'failed';

interface BatchFile {
  /** 0-based position in the upload, which is what `passwords` is keyed by. */
  index: number;
  fileName: string;
  status: FileStatus;
  source: SourceId | null;
  sourceLabel: string | null;
  /** How it was read: a PDF reader, or 'table' for a CSV or Excel export. */
  via: 'adapter' | 'layout' | 'model' | 'table' | null;
  rowCount: number;
  skippedRows: { index: number; reason: string; values: Record<string, string> }[];
  /** Set when the file did not parse. */
  reason?: string;
  message?: string;
}

/** A row in the combined preview, tagged with where it came from. */
interface BatchRow extends FlaggedRow {
  counterpartyRaw?: string | null;
  upiVpa?: string | null;
  fileIndex: number;
  fileName: string;
}

/**
 * POST /api/statements/parse-batch — read several statements as one import.
 *
 * A quarter is three files, and three files imported one at a time are three
 * chances to import the same fortnight twice: banks routinely repeat the tail
 * of the previous period at the top of the next. So duplicate detection runs
 * across the whole batch, not within each file — which it gets for free by
 * numbering every row once across the batch and handing the lot to the same
 * `flagDuplicates` the single-file path uses.
 *
 * A file that cannot be read does not sink the import. It comes back in the
 * list with a status and a reason, and the rest still commit.
 */
export const parseStatementBatch: RequestHandler = async (req, res) => {
  const userId = currentUserId(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0)
    throw new HttpError(400, 'Expected at least one statement in the "files" field');

  const { accountId, passwords } = batchBodySchema.parse(req.body);
  await requireAccount(userId, accountId);

  const summaries: BatchFile[] = [];
  const combined: BatchRow[] = [];

  for (const [index, file] of files.entries()) {
    const fileName = file.originalname ?? `file-${index + 1}.pdf`;
    const base: Omit<BatchFile, 'status'> = {
      index,
      fileName,
      source: null,
      sourceLabel: null,
      via: null,
      rowCount: 0,
      skippedRows: [],
    };

    if (file.size === 0) {
      summaries.push({ ...base, status: 'failed', reason: 'empty', message: 'The file is empty' });
      continue;
    }

    try {
      const read: {
        rows: (ParsedRow & { counterpartyRaw?: string | null; upiVpa?: string | null })[];
        errors: BatchFile['skippedRows'];
        source: SourceId;
        sourceLabel: string;
        via: NonNullable<BatchFile['via']>;
        note?: string;
      } = isPdfFile(file.buffer, fileName)
        ? await readStatement(file.buffer, passwords[String(index)])
        : { ...readTable(file.buffer, fileName), source: 'unknown', via: 'table' };
      summaries.push({
        ...base,
        status: 'parsed',
        source: read.source,
        sourceLabel: read.sourceLabel,
        via: read.via,
        rowCount: read.rows.length,
        skippedRows: read.errors,
        ...(read.note ? { message: read.note } : {}),
      });

      for (const row of read.rows) {
        // One numbering across the batch: it is what makes an "already seen"
        // match point at a row the user can actually find, and what lets the
        // existing dedup see across files without knowing files exist.
        combined.push({
          ...row,
          index: combined.length + 1,
          duplicate: null,
          fileIndex: index,
          fileName,
        });
      }
    } catch (error) {
      const http = asHttpError(error);
      const reason =
        (http?.details as { reason?: string } | undefined)?.reason ??
        (error instanceof Error ? 'failed' : 'failed');
      summaries.push({
        ...base,
        status:
          reason === 'password-required'
            ? 'needs-password'
            : reason === 'incorrect-password'
              ? 'wrong-password'
              : 'failed',
        reason,
        message: http?.message ?? 'This statement could not be read',
      });
    }
  }

  const flagged = flagDuplicates(combined, await existingNear(accountId, combined)).map(
    (row, i) => ({ ...combined[i], duplicate: row.duplicate }),
  );

  // A cross-file match reads as "row 412 in this file" unless it is told which
  // file row 412 was in.
  const byIndex = new Map(flagged.map((row) => [row.index, row]));
  for (const row of flagged) {
    const match = row.duplicate;
    if (match?.kind !== 'in-file' || match.matchesRowIndex === undefined) continue;
    const earlier = byIndex.get(match.matchesRowIndex);
    if (earlier && earlier.fileIndex !== row.fileIndex) {
      match.reason = `Same amount and merchant as a row in ${earlier.fileName}`;
    }
  }

  res.json({
    status: 'batch-preview',
    accountId,
    files: summaries,
    filesParsed: summaries.filter((f) => f.status === 'parsed').length,
    filesFailed: summaries.filter((f) => f.status !== 'parsed').length,
    totalRows: flagged.length,
    duplicateCount: flagged.filter((r) => r.duplicate).length,
    crossFileDuplicateCount: flagged.filter(
      (r) => r.duplicate?.kind === 'in-file' && r.duplicate.reason.includes('as a row in '),
    ).length,
    rows: flagged,
  });
};
