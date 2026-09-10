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
import {
  AnthropicStatementReader,
  StatementReaderConfigurationError,
  StatementReaderResponseError,
  type StatementReader,
} from '../services/ai/statement';
import { dateRangeOf, flagDuplicates, type ExistingTransaction } from '../services/parsing/dedup';
import {
  extractPdfText,
  IncorrectPasswordError,
  inspectPdf,
  PasswordRequiredError,
  UnreadablePdfError,
} from '../services/parsing/pdf';
import { parseGenericStatement, toPlainText } from '../services/parsing/statement';

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

  let pages;
  try {
    pages = await extractPdfText(buffer, password);
  } catch (error) {
    if (error instanceof PasswordRequiredError) {
      throw new HttpError(400, 'This statement is password-protected. Enter its password to continue.', {
        reason: 'password-required',
      });
    }
    if (error instanceof IncorrectPasswordError) {
      throw new HttpError(400, 'That password did not open the statement. Check it and try again.', {
        reason: 'incorrect-password',
      });
    }
    if (error instanceof UnreadablePdfError) {
      throw new HttpError(400, error.message, { reason: 'unreadable' });
    }
    throw error;
  }

  // The deterministic reader first, always. It is reproducible and free; the
  // model is neither, and is here for the layouts geometry cannot settle.
  const generic = parseGenericStatement(pages);
  let parsed = generic ? { rows: generic.rows, errors: generic.errors } : null;
  let source: 'layout' | 'model' = 'layout';
  let modelCalls = 0;

  if (!parsed) {
    const text = toPlainText(pages);
    if (!text.trim()) {
      throw new HttpError(400, 'No text could be read from this PDF. It may be a scan of a paper statement.', {
        reason: 'no-text',
      });
    }

    try {
      const read = await getReader().read(text);
      parsed = { rows: read.rows, errors: read.errors };
      source = 'model';
      modelCalls = read.calls;
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

  if (parsed.rows.length === 0) {
    throw new HttpError(400, 'No transactions were found in this statement.', {
      reason: 'no-rows',
    });
  }

  // Same duplicate pass as the CSV path: only rows that could possibly match,
  // by account and by the incoming file's date span.
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

  // Deliberately the same envelope the CSV upload returns, so the client's
  // confirm screen and POST /transactions/commit work unchanged.
  res.json({
    status: 'preview',
    fileName: req.file?.originalname ?? null,
    accountId,
    preset: source === 'layout' ? 'pdf-generic' : 'pdf-model',
    source,
    modelCalls,
    pages: pages.length,
    confidence: generic?.confidence ?? null,
    totalRows: rows.length,
    duplicateCount: rows.filter((r) => r.duplicate).length,
    skippedRows: parsed.errors,
    rows,
  });
};
