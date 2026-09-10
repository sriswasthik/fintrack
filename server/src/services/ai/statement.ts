/**
 * The fallback reader, for statements whose layout the geometric parser could
 * not settle (services/parsing/statement.ts).
 *
 * It is a fallback and nothing more. The deterministic path is tried first and
 * wins whenever it is confident, because a rule engine reading a table is
 * reproducible and a model reading one is not. This exists because there are
 * as many statement layouts as there are banks, and a column-splitter tuned to
 * one of them is not a product.
 *
 * Two rules shape what comes back. The model is given the page text and asked
 * only to *transcribe* it as rows — never to categorize, never to compute a
 * total, never to fill in a missing figure. And nothing it returns is trusted
 * until Zod has checked its shape and every row has been re-parsed by the same
 * date and amount readers the deterministic path uses.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { extractMerchant } from '../parsing/normalize';
import { parseStatementDate, detectDateOrder } from '../parsing/statement';
import type { ParsedRow, RowError } from '../parsing/csv';

export const STATEMENT_MODEL = 'claude-opus-5';

/** Enough for a long statement; a page of rows is not a long answer. */
const MAX_TOKENS = 16000;

/**
 * What the model is allowed to return.
 *
 * Amounts arrive as strings on purpose: a bank prints `1,23,456.78` and a model
 * asked for a number will helpfully reformat it, which is a chance to change it.
 * Taking the string back verbatim and parsing it here means the same reader
 * handles every source.
 */
const ModelRow = z.object({
  date: z.string().min(1),
  description: z.string().min(1),
  debit: z.string().nullable().optional(),
  credit: z.string().nullable().optional(),
  balance: z.string().nullable().optional(),
});

const ModelResponse = z.object({ rows: z.array(ModelRow) });

export type ModelStatementRow = z.infer<typeof ModelRow>;

export const SYSTEM_PROMPT = `You transcribe bank statements. You are given the text of a statement PDF, already extracted, with each line of the page on its own line.

Return every transaction row you can see, as JSON:

{"rows": [{"date": "...", "description": "...", "debit": "...", "credit": "...", "balance": "..."}]}

Rules:
- Copy values EXACTLY as they appear in the text. Do not reformat dates, do not restyle numbers, do not expand abbreviations, do not tidy up merchant names.
- A row has EITHER a debit or a credit, never both. Use null for the one it does not have.
- balance is optional; use null when the statement does not show one.
- Skip anything that is not a transaction: headers, column titles, page numbers, opening and closing balance lines, subtotals, marketing text.
- Never invent a row, a date or an amount. If a line is unreadable, leave it out.
- Never categorize. "description" is the raw narration text, nothing else.
- Return only the JSON object. No commentary, no markdown fence.`;

/** Raised when the model cannot be reached or is not configured. */
export class StatementReaderConfigurationError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StatementReaderConfigurationError';
  }
}

/** Raised when the model answered, but not with something usable. */
export class StatementReaderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementReaderResponseError';
  }
}

export interface StatementReadResult {
  rows: ParsedRow[];
  errors: RowError[];
  calls: number;
}

export interface StatementReader {
  read(text: string): Promise<StatementReadResult>;
}

/** Strips a ```json fence if the model added one despite being asked not to. */
export function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Turns the model's transcription into the same rows every other source
 * produces.
 *
 * Every field is re-derived here rather than taken on trust: the date goes
 * through the same reader the deterministic path uses, the amount through the
 * same one, and the merchant through the same normalizer. A row the model
 * returned that does not survive that becomes an error, not a guess.
 */
export function toParsedRows(rows: ModelStatementRow[]): StatementReadResult {
  const order = detectDateOrder(rows.map((r) => r.date));
  const parsed: ParsedRow[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    const index = i + 1;
    const values: Record<string, string> = {
      date: row.date,
      description: row.description,
      debit: row.debit ?? '',
      credit: row.credit ?? '',
      balance: row.balance ?? '',
    };

    const date = parseStatementDate(row.date, order);
    if (!date) {
      errors.push({ index, reason: `Unrecognised date: "${row.date}"`, values });
      return;
    }

    const description = row.description.trim();
    if (!description) {
      errors.push({ index, reason: 'Missing description', values });
      return;
    }

    const debit = money(row.debit);
    const credit = money(row.credit);
    if (debit === null && credit === null) {
      errors.push({ index, reason: 'Row has neither a debit nor a credit', values });
      return;
    }
    if (debit !== null && credit !== null) {
      errors.push({ index, reason: 'Row has both a debit and a credit', values });
      return;
    }

    const { rawMerchant, normalizedMerchant } = extractMerchant(description);
    parsed.push({
      index,
      date,
      postedDate: null,
      description,
      rawMerchant,
      normalizedMerchant,
      amount: debit !== null ? debit : -credit!,
    });
  });

  return { rows: parsed, errors, calls: 0 };
}

/** A money cell as the model copied it, or null when it was blank. */
function money(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '-') return null;
  const cleaned = trimmed.replace(/[₹$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses and validates a model response. Throws rather than half-trusting it. */
export function parseModelResponse(text: string): ModelStatementRow[] {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    throw new StatementReaderResponseError('The reader did not return JSON');
  }

  const result = ModelResponse.safeParse(json);
  if (!result.success) {
    throw new StatementReaderResponseError(
      `The reader returned rows in an unexpected shape: ${result.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return result.data.rows;
}

export interface AnthropicStatementReaderOptions {
  client?: Anthropic;
  model?: string;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export class AnthropicStatementReader implements StatementReader {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onUsage?: AnthropicStatementReaderOptions['onUsage'];

  constructor(options: AnthropicStatementReaderOptions = {}) {
    // Reads ANTHROPIC_API_KEY from the environment. Server-side only.
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? STATEMENT_MODEL;
    this.onUsage = options.onUsage;
  }

  async read(text: string): Promise<StatementReadResult> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // Identical on every call, so it is the natural cache prefix.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: text }],
        // Transcription, not analysis: the answer is in front of it.
        output_config: { effort: 'low' },
      });
    } catch (error) {
      throw new StatementReaderConfigurationError(
        error instanceof Error ? error.message : 'Statement reader is not usable',
        error,
      );
    }

    this.onUsage?.({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    const body = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return { ...toParsedRows(parseModelResponse(body)), calls: 1 };
  }
}
