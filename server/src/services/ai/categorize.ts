/**
 * LLM-assisted categorization — the fallback for whatever the deterministic
 * rule engine could not resolve (PROJECT_CONTEXT.md §4, §7).
 *
 * Guardrails, all of them load-bearing:
 *
 *   * The model is only ever asked about a *normalized merchant string*. No
 *     amounts, dates, account names or descriptions leave the server, so the
 *     smallest useful thing is sent rather than a transaction.
 *   * Output is constrained by a JSON schema and then validated again with Zod
 *     against the Category enum. Anything that fails either gate becomes
 *     UNCATEGORIZED and goes to the review queue — an out-of-schema value is
 *     never written to the database.
 *   * Merchants are batched, so a hundred unknown merchants is a handful of
 *     calls rather than a hundred.
 *
 * The Anthropic call lives behind `MerchantCategorizer` so the pipeline can be
 * driven by a stub in tests and in environments with no API key.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { Category } from '../../generated/prisma/enums';
import { CATEGORIES } from '../rules/categories';

/** Anthropic model used for categorization. */
export const CATEGORIZATION_MODEL = 'claude-opus-5';

/** Merchants per request. Keeps a call cheap and its output well inside max_tokens. */
export const MERCHANT_BATCH_SIZE = 20;

/** Batches in flight at once. */
const CONCURRENT_BATCHES = 4;

/**
 * Below this, an AI answer is treated as a suggestion rather than a decision:
 * it is stored, but the transaction still appears in the review queue.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** What the model is asked to return for one merchant. */
const merchantVerdictSchema = z.object({
  merchant: z.string(),
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});

const batchVerdictSchema = z.object({
  results: z.array(merchantVerdictSchema),
});

export type MerchantVerdict = z.infer<typeof merchantVerdictSchema>;

/** A verdict the pipeline is willing to act on, plus how it was reached. */
export interface CategorizationOutcome {
  merchant: string;
  category: Category;
  confidence: number;
  reason: string;
  /** True when the model's answer failed validation and was replaced. */
  rejected?: boolean;
}

export interface MerchantCategorizer {
  /**
   * Categorizes a batch of normalized merchant strings.
   *
   * Implementations must return one outcome per input merchant, in any order.
   * A merchant the model did not answer for, or answered for invalidly, must
   * come back as UNCATEGORIZED at confidence 0 rather than being dropped.
   */
  categorize(merchants: string[]): Promise<CategorizationOutcome[]>;
}

export const SYSTEM_PROMPT = `You categorize bank-transaction merchants for a personal finance app.

The users are in India. The merchants are Indian ones, the transactions are mostly UPI, and every amount is in Indian rupees (INR). Read an unfamiliar name in that context first: prefer the Indian company, chain or service a name refers to over a similarly-named one elsewhere, and treat Indian abbreviations and acronyms as what they mean in India. Merchants from outside India do appear — a subscription, a foreign trip — so this is which way to lean on an ambiguous name, not a rule that every name is Indian.

What that means in practice:
- Names arrive from UPI narrations and Indian bank statements, so expect shortened, run-together and ALL-CAPS forms: "SWIGGYINSTAMART", "BAJAJFIN", "IRCTCUTS", "PAYTMQR".
- A state electricity board or distribution company (BESCOM, MSEDCL, TANGEDCO, TSSPDCL, PSPCL, a "...VVNL" or "...GVCL" acronym) is UTILITIES, as is piped city gas, an LPG supplier, broadband, DTH and a mobile recharge.
- A UPI payment to an individual is a payment to a person, not a shop. If a merchant name is a personal name, or a bare mobile number, or a UPI handle with no business in it, the honest answer is usually UNCATEGORIZED — you cannot tell what the money was for from a person's name.
- INVESTMENTS covers an SIP, a mutual-fund or AMC debit, a broker (Zerodha, Groww, Upstox), NPS, PPF and a demat charge. This is money the person still has; it is not a bill.
- EMI_LOAN is repaying borrowed money: an EMI instalment, a personal, vehicle or home loan, an NBFC or housing-finance company, a buy-now-pay-later settlement.
- CASH_WITHDRAWAL is cash out of an ATM or over the counter ("ATM", "ATW", "NWD", "CASH WDL"). Do not guess what the cash was later spent on.
- INSURANCE is a premium. Indian financial groups lend, insure and manage funds under one name, so read the whole name: "ICICI Prudential Life" is INSURANCE and "ICICI Prudential" alone is the asset manager; "LIC" is INSURANCE and "LIC HFL" is a home lender.

You will be given a list of merchant names that have already been cleaned up from raw bank descriptors. For each one, choose the single best category.

You MUST choose from exactly this list of categories, and nothing else:
${CATEGORIES.join('\n')}

Rules:
- Use UNCATEGORIZED when you genuinely cannot tell what the merchant is. That is a valid, useful answer — a wrong guess is worse than an honest "I don't know", because a wrong category silently corrupts the user's spending totals.
- confidence is your own probability that the category is right, from 0 to 1. Be honest and calibrated: use a low number when the merchant name is generic, truncated, or could plausibly belong to several categories. Do not inflate it.
- reason is one short clause explaining the choice, for a human reviewing your answer. No more than 20 words.
- TRANSFER is for movements between a person's own accounts and for peer-to-peer payment networks, not for ordinary spending.
- INCOME is for money earned: salary, payroll, client payments.
- REFUND is decided by the app from transaction amounts, not by you. Never return REFUND — categorize the merchant as what it sells.
- Return exactly one result per merchant you are given, echoing the merchant name back unchanged.`;

function buildUserMessage(merchants: string[]): string {
  return `Categorize these ${merchants.length} merchants:\n\n${merchants
    .map((m, i) => `${i + 1}. ${m}`)
    .join('\n')}`;
}

/**
 * Reconciles what came back against what was asked, so the caller always gets
 * exactly one outcome per input merchant.
 *
 * Anything missing, duplicated, unrecognised or invalid becomes UNCATEGORIZED
 * at zero confidence and is marked rejected. This is the last gate before the
 * database, and it is deliberately unforgiving.
 */
export function reconcileVerdicts(
  merchants: string[],
  verdicts: MerchantVerdict[],
): CategorizationOutcome[] {
  const byMerchant = new Map<string, MerchantVerdict>();
  for (const verdict of verdicts) {
    const parsed = merchantVerdictSchema.safeParse(verdict);
    if (!parsed.success) continue;
    // A merchant answered twice is ambiguous; keep the first and ignore the rest.
    if (!byMerchant.has(parsed.data.merchant)) byMerchant.set(parsed.data.merchant, parsed.data);
  }

  return merchants.map((merchant) => {
    const verdict = byMerchant.get(merchant);
    if (!verdict) {
      return {
        merchant,
        category: 'UNCATEGORIZED' as Category,
        confidence: 0,
        reason: 'The model returned no usable answer for this merchant',
        rejected: true,
      };
    }
    // The model is told never to return REFUND — that is decided from amounts.
    if (verdict.category === 'REFUND') {
      return {
        merchant,
        category: 'UNCATEGORIZED' as Category,
        confidence: 0,
        reason: 'Model returned REFUND, which is decided from transaction amounts',
        rejected: true,
      };
    }
    return {
      merchant,
      category: verdict.category,
      confidence: verdict.confidence,
      reason: verdict.reason,
    };
  });
}

/** Splits a list into chunks of at most `size`. */
export function batched<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Raised when the categorizer is misconfigured — no credentials, a rejected
 * key, a model the account cannot use.
 *
 * Kept separate from a transient failure on purpose. A network blip should
 * leave merchants unresolved and let the import continue; a misconfiguration
 * that silently did the same would look identical to "the model had no idea
 * about any of these", and categorization would quietly stop working with
 * nothing in the data to say why.
 */
export class CategorizerConfigurationError extends Error {
  constructor(
    message: string,
    readonly underlying?: unknown,
  ) {
    super(message);
    this.name = 'CategorizerConfigurationError';
  }
}

/** True for failures that will repeat until a human changes something. */
function isConfigurationFailure(error: unknown): boolean {
  if (error instanceof Anthropic.AuthenticationError) return true;
  if (error instanceof Anthropic.PermissionDeniedError) return true;
  if (error instanceof Anthropic.NotFoundError) return true;
  // The SDK throws a plain Error when no credential can be resolved at all.
  return error instanceof Error && /authentication method/i.test(error.message);
}

export interface AnthropicCategorizerOptions {
  client?: Anthropic;
  model?: string;
  batchSize?: number;
  /** Called for each completed request, for cost reporting. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; merchants: number }) => void;
}

/** The real categorizer, talking to the Anthropic API. */
export class AnthropicMerchantCategorizer implements MerchantCategorizer {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly onUsage?: AnthropicCategorizerOptions['onUsage'];

  constructor(options: AnthropicCategorizerOptions = {}) {
    // Reads ANTHROPIC_API_KEY (or another configured credential) from the
    // environment. Server-side only — the key never reaches the client bundle.
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? CATEGORIZATION_MODEL;
    this.batchSize = options.batchSize ?? MERCHANT_BATCH_SIZE;
    this.onUsage = options.onUsage;
  }

  async categorize(merchants: string[]): Promise<CategorizationOutcome[]> {
    // A few batches at a time: this runs inside the import request, and a
    // first statement can carry a couple of hundred unfamiliar merchants.
    const queue = batched(merchants, this.batchSize);
    const outcomes: CategorizationOutcome[] = [];
    const worker = async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        outcomes.push(...(await this.categorizeBatch(batch)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENT_BATCHES, queue.length) }, worker));
    return outcomes;
  }

  private async categorizeBatch(merchants: string[]): Promise<CategorizationOutcome[]> {
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 8000,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // The prompt is byte-identical on every call, so it is the natural
            // cache prefix; the merchant list that varies comes after it.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: buildUserMessage(merchants) }],
        output_config: {
          format: zodOutputFormat(batchVerdictSchema),
          // Classification does not repay deep reasoning, and this runs over
          // every unknown merchant a user imports.
          effort: 'low',
        },
      });

      this.onUsage?.({
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        merchants: merchants.length,
      });

      // A refusal or a schema failure both land here as a null parse.
      if (!response.parsed_output) {
        return rejectAll(merchants, `Model returned no parseable output (${response.stop_reason})`);
      }

      return reconcileVerdicts(merchants, response.parsed_output.results);
    } catch (error) {
      // Misconfiguration is fatal: failing softly here would silently disable
      // categorization for every merchant, forever, with nothing to show for it.
      if (isConfigurationFailure(error)) {
        throw new CategorizerConfigurationError(
          error instanceof Error ? error.message : 'Categorizer is not usable',
          error,
        );
      }
      // A transient failure must never abort the import or poison the data: the
      // merchants simply stay unresolved and land in the review queue.
      const message = error instanceof Error ? error.message : 'Unknown error';
      return rejectAll(merchants, `Categorization request failed: ${message}`);
    }
  }
}

function rejectAll(merchants: string[], reason: string): CategorizationOutcome[] {
  return merchants.map((merchant) => ({
    merchant,
    category: 'UNCATEGORIZED' as Category,
    confidence: 0,
    reason,
    rejected: true,
  }));
}
