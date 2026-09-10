/**
 * The monthly natural-language recap (PROJECT_CONTEXT.md §7).
 *
 * One model call, given a dozen pre-computed numbers and nothing else. No
 * transaction rows, no merchant history, no descriptions beyond the ones the
 * anomaly detector already wrote for a human to read.
 *
 * The interesting problem is not getting prose out of a model, it is making
 * sure the prose is *true*. A summary that says "you spent about nine thousand"
 * when the dashboard above it says ₹8,95,949 is worse than no summary at all:
 * it teaches the user that the numbers on this page cannot be trusted. So the
 * output goes through a figure check before anyone sees it —
 *
 *   1. every figure the summary must state has to actually appear, and
 *   2. every figure it does state has to be one we gave it.
 *
 * The second rule is the one that matters. It is a cheap, complete defence
 * against invented numbers: the model cannot smuggle in a total it made up,
 * because any money or percentage figure that is not traceable to the stats
 * block fails the check. Failing twice falls back to the stats rendered as
 * plain text — dull, but never wrong.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { MonthlyStats } from '../summary/stats';
import { formatINR } from '../../utils/currency';

/** Anthropic model used for summaries. */
export const SUMMARY_MODEL = 'claude-opus-5';

/** The length asked for in the prompt. */
export const TARGET_WORDS = { min: 150, max: 250 } as const;

/**
 * The band validation actually enforces, deliberately wider than the target.
 * Rejecting a good 260-word recap for being ten words long would spend a second
 * call to fix nothing; a 60-word note or a 500-word essay is a different
 * deliverable and does get rejected.
 */
export const ACCEPTED_WORDS = { min: 110, max: 340 } as const;

/** At most two calls: the first attempt, and one correction. */
export const MAX_ATTEMPTS = 2;

export interface SummaryResult {
  content: string;
  /** How the text was produced. */
  source: 'model' | 'fallback';
  /** Model calls made. The happy path is 1. */
  calls: number;
  /** Why an attempt was rejected, in order. Empty when the first try passed. */
  rejections: string[];
}

export interface MonthlySummarizer {
  summarize(stats: MonthlyStats): Promise<SummaryResult>;
}

// ---------------------------------------------------------------------------
// Formatting — shared by the prompt, the checker and the fallback, so all three
// agree on what a figure looks like.
// ---------------------------------------------------------------------------

export const money = (amount: number): string => formatINR(amount);

export const percent = (value: number): string => `${value}%`;

const categoryLabel = (category: string): string => category.replace(/_/g, ' ').toLowerCase();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Matches what `money` above produces: the sign sits outside the symbol, so
// "-₹1,23,456.78" must be read as one figure rather than a stray minus and a
// positive amount.
const MONEY_PATTERN = /-?₹\s?\d[\d,]*(?:\.\d{1,2})?/g;
const PERCENT_PATTERN = /-?\d+(?:\.\d+)?\s?%/g;

const toNumber = (token: string): number => Number(token.replace(/[₹,%\s]/g, ''));

/** Money figures found in a piece of text, as numbers. */
export function moneyFigures(text: string): number[] {
  return (text.match(MONEY_PATTERN) ?? []).map(toNumber);
}

/** Percentage figures found in a piece of text, as numbers. */
export function percentFigures(text: string): number[] {
  return (text.match(PERCENT_PATTERN) ?? []).map(toNumber);
}

/**
 * Every money figure the summary is allowed to contain.
 *
 * Anomaly explanations are parsed for their own figures because the model is
 * asked to mention one or two of them, and they are quoted back verbatim.
 */
export function permittedMoney(stats: MonthlyStats): number[] {
  const values = [
    stats.spend,
    stats.income,
    Math.abs(stats.net),
    stats.previousSpend,
    stats.previousIncome,
    ...stats.topCategories.flatMap((c) => [c.amount, c.previousAmount]),
    ...(stats.topMerchant ? [stats.topMerchant.amount] : []),
    ...stats.anomalies.flatMap((a) => moneyFigures(a.explanation)),
  ];
  // A month-over-month difference is arithmetic on figures we supplied, not an
  // invention, so allow the model to state it.
  const differences = [
    Math.abs(stats.spend - stats.previousSpend),
    Math.abs(stats.income - stats.previousIncome),
    ...stats.topCategories.map((c) => Math.abs(c.amount - c.previousAmount)),
  ];
  return [...values, ...differences];
}

/** Every percentage the summary is allowed to contain. */
export function permittedPercent(stats: MonthlyStats): number[] {
  return [
    ...(stats.spendChange === null ? [] : [stats.spendChange, Math.abs(stats.spendChange)]),
    ...(stats.incomeChange === null ? [] : [stats.incomeChange, Math.abs(stats.incomeChange)]),
    ...(stats.savingsRate === null ? [] : [stats.savingsRate]),
    ...stats.topCategories.flatMap((c) => [
      c.share,
      ...(c.change === null ? [] : [c.change, Math.abs(c.change)]),
    ]),
    ...stats.anomalies.flatMap((a) => percentFigures(a.explanation)),
  ];
}

/**
 * The figures the summary must state, with the exact text to look for.
 *
 * Spend and income are the two numbers a reader came for; the savings rate is
 * the one the recap exists to editorialize about. Anything beyond these three
 * is the model's judgement to make.
 */
export function requiredFigures(stats: MonthlyStats): { label: string; value: number }[] {
  return [
    { label: `total spend of ${money(stats.spend)}`, value: stats.spend },
    { label: `total income of ${money(stats.income)}`, value: stats.income },
  ];
}

/** True when `found` is `expected`, or `expected` rounded for readability. */
const matches = (found: number, expected: number): boolean => Math.abs(found - expected) < 1;

export interface FigureCheck {
  ok: boolean;
  /** One human-readable line per failure, reused as the correction to the model. */
  problems: string[];
}

/**
 * Checks a summary against the stats it was written from.
 *
 * Deliberately arithmetic rather than semantic: it cannot tell whether the
 * prose is *insightful*, only whether every number in it is one of ours and
 * the headline ones are present. That is the part a person cannot check at a
 * glance, and the part that does real damage when it is wrong.
 */
export function checkFigures(text: string, stats: MonthlyStats): FigureCheck {
  const problems: string[] = [];

  const foundMoney = moneyFigures(text);
  const foundPercent = percentFigures(text);

  for (const required of requiredFigures(stats)) {
    if (!foundMoney.some((found) => matches(found, required.value))) {
      problems.push(
        `The ${required.label} is missing — write it exactly as ${money(required.value)}.`,
      );
    }
  }

  if (stats.savingsRate !== null && !foundPercent.some((f) => matches(f, stats.savingsRate!))) {
    problems.push(
      `The savings rate is missing — write it exactly as ${percent(stats.savingsRate)}.`,
    );
  }

  const allowedMoney = permittedMoney(stats);
  for (const found of foundMoney) {
    if (!allowedMoney.some((allowed) => matches(found, allowed))) {
      problems.push(
        `${money(found)} is not one of the figures you were given. Use only the numbers in the data.`,
      );
    }
  }

  const allowedPercent = permittedPercent(stats);
  for (const found of foundPercent) {
    if (!allowedPercent.some((allowed) => matches(found, allowed))) {
      problems.push(
        `${percent(found)} is not one of the figures you were given. Use only the numbers in the data.`,
      );
    }
  }

  const words = countWords(text);
  if (words < ACCEPTED_WORDS.min) {
    problems.push(`Too short at ${words} words — write ${TARGET_WORDS.min}-${TARGET_WORDS.max}.`);
  }
  if (words > ACCEPTED_WORDS.max) {
    problems.push(`Too long at ${words} words — write ${TARGET_WORDS.min}-${TARGET_WORDS.max}.`);
  }

  // The same complaint about several figures reads as noise in a retry.
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You write the monthly recap for a personal finance app. The reader is the person whose money this is.

You will be given a small JSON block of figures that the app has already computed, and a list of the exact strings to use when you mention them. That block is the only thing you know. You have no access to individual transactions and must not imply that you do.

Absolute rules about numbers:
- Every currency amount and percentage you write MUST come from the data you were given, copied exactly as shown in "Write these exactly as".
- Never calculate a new figure, never estimate, never round to something friendlier, and never write a number the data does not contain. If you want to say something you have no figure for, say it qualitatively instead or leave it out.
- If a value is null, that fact is not available. Do not guess at it.

What to write:
- ${TARGET_WORDS.min}-${TARGET_WORDS.max} words of plain English prose. No headings, no bullet points, no markdown, no preamble like "Here is your summary".
- Open with how the month went overall, naming the total spend, the total income, and the savings rate.
- Then the shape of the spending: the largest categories and how they moved against last month.
- Then call out ONE or TWO things worth acting on — an anomaly from the list, a category that jumped, a subscription that got dearer. Be specific about which and why it matters.
- Write like a knowledgeable friend, not a bank statement: warm, direct, second person, contractions welcome. No exclamation marks, no cheerleading, no scolding. A month where spending rose is a fact, not a failure.
- If the month looks unremarkable, say so plainly rather than manufacturing drama.`;

/** The exact strings the model is told to reuse, so its prose and ours agree. */
export function figureCrib(stats: MonthlyStats): string {
  const lines = [
    `total spend: ${money(stats.spend)}`,
    `total income: ${money(stats.income)}`,
    `net: ${money(stats.net)}`,
    ...(stats.savingsRate === null ? [] : [`savings rate: ${percent(stats.savingsRate)}`]),
    ...(stats.spendChange === null
      ? []
      : [`spend vs ${stats.previousMonthLabel}: ${percent(stats.spendChange)}`]),
    ...(stats.incomeChange === null
      ? []
      : [`income vs ${stats.previousMonthLabel}: ${percent(stats.incomeChange)}`]),
    ...stats.topCategories.map(
      (c) =>
        `${categoryLabel(c.category)}: ${money(c.amount)}` +
        (c.change === null ? '' : ` (${percent(c.change)} vs ${stats.previousMonthLabel})`),
    ),
    ...(stats.topMerchant
      ? [`top merchant ${stats.topMerchant.merchant}: ${money(stats.topMerchant.amount)}`]
      : []),
  ];
  return lines.join('\n');
}

export function buildUserMessage(stats: MonthlyStats): string {
  return [
    `Write the recap for ${stats.monthLabel}.`,
    '',
    'Data:',
    JSON.stringify(stats, null, 2),
    '',
    'Write these exactly as:',
    figureCrib(stats),
  ].join('\n');
}

/** The correction sent on the second attempt, naming what was actually wrong. */
export function buildCorrectionMessage(problems: string[]): string {
  return [
    'That draft did not pass the figure check. Problems:',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Rewrite the whole recap. Every currency amount and percentage must be copied exactly from the "Write these exactly as" list — do not compute, estimate or round anything. Keep the same length and tone.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * The stats as plain text, for when the model cannot be trusted or reached.
 *
 * Not a summary — a statement of the figures. It exists so the page is never
 * empty and never wrong, and so a missing API key degrades the feature instead
 * of breaking the month.
 */
export function renderFallback(stats: MonthlyStats): string {
  const parts: string[] = [
    `In ${stats.monthLabel} you spent ${money(stats.spend)} and took in ${money(stats.income)}, ` +
      `leaving ${money(stats.net)} across ${stats.transactions} transactions.`,
  ];

  if (stats.savingsRate !== null) {
    parts.push(`That is a savings rate of ${percent(stats.savingsRate)}.`);
  }
  if (stats.spendChange !== null) {
    const direction = stats.spendChange >= 0 ? 'up' : 'down';
    parts.push(
      `Spending was ${direction} ${percent(Math.abs(stats.spendChange))} against ` +
        `${stats.previousMonthLabel} (${money(stats.previousSpend)}).`,
    );
  }

  if (stats.topCategories.length > 0) {
    const list = stats.topCategories
      .map((c) => `${categoryLabel(c.category)} ${money(c.amount)}`)
      .join(', ');
    parts.push(`The largest categories were ${list}.`);
  }
  if (stats.topMerchant) {
    parts.push(
      `The most spent at one merchant was ${money(stats.topMerchant.amount)} at ${stats.topMerchant.merchant}.`,
    );
  }

  if (stats.anomalies.length > 0) {
    parts.push('Flagged this month:');
    stats.anomalies.forEach((anomaly) => parts.push(anomaly.explanation));
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// The Anthropic summarizer
// ---------------------------------------------------------------------------

/** Raised when the summarizer cannot work until a human changes something. */
export class SummarizerConfigurationError extends Error {
  constructor(
    message: string,
    readonly underlying?: unknown,
  ) {
    super(message);
    this.name = 'SummarizerConfigurationError';
  }
}

function isConfigurationFailure(error: unknown): boolean {
  if (error instanceof Anthropic.AuthenticationError) return true;
  if (error instanceof Anthropic.PermissionDeniedError) return true;
  if (error instanceof Anthropic.NotFoundError) return true;
  // The SDK throws a plain Error when no credential can be resolved at all.
  return error instanceof Error && /authentication method/i.test(error.message);
}

export interface AnthropicSummarizerOptions {
  client?: Anthropic;
  model?: string;
  /** Called after each completed request, for cost reporting. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export class AnthropicMonthlySummarizer implements MonthlySummarizer {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onUsage?: AnthropicSummarizerOptions['onUsage'];

  constructor(options: AnthropicSummarizerOptions = {}) {
    // Reads ANTHROPIC_API_KEY from the environment. Server-side only — the key
    // never reaches the client bundle.
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? SUMMARY_MODEL;
    this.onUsage = options.onUsage;
  }

  async summarize(stats: MonthlyStats): Promise<SummaryResult> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildUserMessage(stats) }];
    const rejections: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const text = await this.request(messages);
      const check = checkFigures(text, stats);

      if (check.ok) return { content: text, source: 'model', calls: attempt, rejections };

      rejections.push(...check.problems);
      // Continue the same conversation rather than starting a new one: the
      // model can see its own draft and what was wrong with it, and the cached
      // system prefix still applies.
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: buildCorrectionMessage(check.problems) });
    }

    return {
      content: renderFallback(stats),
      source: 'fallback',
      calls: MAX_ATTEMPTS,
      rejections,
    };
  }

  private async request(messages: Anthropic.MessageParam[]): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // Byte-identical on every call, so it is the natural cache prefix;
            // the month's figures come after it.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
        // Three hundred words of prose from a dozen numbers does not repay deep
        // reasoning, and this runs once a month per user.
        output_config: { effort: 'low' },
      });

      this.onUsage?.({
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });

      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    } catch (error) {
      if (isConfigurationFailure(error)) {
        throw new SummarizerConfigurationError(
          error instanceof Error ? error.message : 'Summarizer is not usable',
          error,
        );
      }
      throw error;
    }
  }
}
