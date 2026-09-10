import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { MonthlyStats } from '../summary/stats';
import {
  ACCEPTED_WORDS,
  AnthropicMonthlySummarizer,
  buildCorrectionMessage,
  buildUserMessage,
  checkFigures,
  countWords,
  figureCrib,
  moneyFigures,
  permittedMoney,
  renderFallback,
  SUMMARY_MODEL,
  SummarizerConfigurationError,
  SYSTEM_PROMPT,
} from './summarize';

// ---------------------------------------------------------------------------
// Fixtures — June 2026 from the seeded dataset, the month whose figures were
// hand-checked against the dashboard in Phase 5.
// ---------------------------------------------------------------------------

const JUNE: MonthlyStats = {
  month: '2026-06',
  monthLabel: 'June 2026',
  previousMonth: '2026-05',
  previousMonthLabel: 'May 2026',
  spend: 8959.49,
  income: 10926.72,
  net: 1967.23,
  transactions: 111,
  previousSpend: 13295.66,
  previousIncome: 8225.77,
  spendChange: -32.6,
  incomeChange: 32.8,
  savingsRate: 18,
  topCategories: [
    { category: 'HOUSING', amount: 2150, previousAmount: 2150, change: 0, share: 24 },
    { category: 'SHOPPING', amount: 1945.84, previousAmount: 4917.4, change: -60.4, share: 21.7 },
    { category: 'TRAVEL', amount: 1052.14, previousAmount: 1371.73, change: -23.3, share: 11.7 },
  ],
  topMerchant: { merchant: 'PRESTIGE PROPERTY MGMT', amount: 2150, transactions: 1 },
  anomalies: [
    {
      type: 'SUBSCRIPTION_PRICE_INCREASE',
      severity: 'MEDIUM',
      explanation: 'NETFLIX went up from ₹499.00 to ₹649.00 (+30%, ₹150.00 more a month).',
    },
  ],
};

/** Padding, so a fixture can clear the minimum word count without saying much. */
const filler = (words: number) => ' word'.repeat(words).trim();

const goodSummary = (extra = '') =>
  `June was a calmer month. You spent ₹8,959.49 against income of ₹10,926.72, ` +
  `which works out to a savings rate of 18%. Spending fell 32.6% from May. ` +
  `Housing held steady at ₹2,150.00, shopping dropped 60.4% to ₹1,945.84, and ` +
  `travel came to ₹1,052.14. Worth a look: NETFLIX went up from ₹499.00 to ₹649.00. ` +
  extra +
  filler(ACCEPTED_WORDS.min);

// ---------------------------------------------------------------------------
// Figure extraction
// ---------------------------------------------------------------------------

describe('moneyFigures', () => {
  it('pulls out amounts however they are punctuated', () => {
    expect(moneyFigures('₹8,959.49 and ₹12 and ₹1,000 and ₹0.50')).toEqual([
      8959.49, 12, 1000, 0.5,
    ]);
  });

  it('is not fooled by a bare number', () => {
    expect(moneyFigures('111 transactions')).toEqual([]);
  });
});

describe('permittedMoney', () => {
  it('includes the figures quoted inside an anomaly explanation', () => {
    // The model is asked to mention anomalies, which quote their own amounts.
    expect(permittedMoney(JUNE)).toEqual(expect.arrayContaining([499, 649, 150]));
  });

  it('includes month-over-month differences, which are arithmetic on our own numbers', () => {
    expect(permittedMoney(JUNE)).toEqual(
      expect.arrayContaining([Math.abs(JUNE.spend - JUNE.previousSpend)]),
    );
  });
});

// ---------------------------------------------------------------------------
// The figure check — the guardrail this whole feature turns on
// ---------------------------------------------------------------------------

describe('checkFigures', () => {
  it('passes a summary that states the figures it was given', () => {
    expect(checkFigures(goodSummary(), JUNE)).toEqual({ ok: true, problems: [] });
  });

  it('rejects a number the model made up', () => {
    const invented = goodSummary('Your dining bill of ₹612.40 was the surprise. ');
    const check = checkFigures(invented, JUNE);

    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('₹612.40 is not one of the figures');
  });

  it('rejects an invented percentage just as firmly', () => {
    const check = checkFigures(goodSummary('Groceries were up 47% on the year. '), JUNE);

    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('47% is not one of the figures');
  });

  it('rejects a summary that leaves out the headline figures', () => {
    const vague = `June went well. You spent a bit less than last month and came out ahead. ${filler(ACCEPTED_WORDS.min)}`;
    const check = checkFigures(vague, JUNE);

    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('₹8,959.49');
    expect(check.problems.join(' ')).toContain('₹10,926.72');
    expect(check.problems.join(' ')).toContain('18%');
  });

  it('allows a figure rounded to the rupee, which is a reading choice not an invention', () => {
    const rounded = goodSummary().replace('₹8,959.49', '₹8,959');
    expect(checkFigures(rounded, JUNE).ok).toBe(true);
  });

  it('does not allow rounding that changes the number', () => {
    const wrong = goodSummary().replace('₹8,959.49', '₹9,000');
    expect(checkFigures(wrong, JUNE).ok).toBe(false);
  });

  it('rejects a one-liner and an essay alike', () => {
    const short = 'You spent ₹8,959.49, earned ₹10,926.72, and saved 18%.';
    expect(checkFigures(short, JUNE).problems.join(' ')).toContain('Too short');

    const long = goodSummary() + filler(ACCEPTED_WORDS.max);
    expect(checkFigures(long, JUNE).problems.join(' ')).toContain('Too long');
  });

  it('does not repeat the same complaint once per offending figure', () => {
    const check = checkFigures(goodSummary('Also ₹612.40 and ₹612.40 and ₹612.40. '), JUNE);
    expect(check.problems.filter((p) => p.includes('₹612.40'))).toHaveLength(1);
  });

  it('does not ask for a savings rate when there was no income to save from', () => {
    const noIncome: MonthlyStats = { ...JUNE, income: 0, savingsRate: null };
    const text = `You spent ₹8,959.49 this month against income of ₹0.00. ${filler(ACCEPTED_WORDS.min)}`;
    expect(checkFigures(text, noIncome).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe('the prompt', () => {
  it('gives the model the figures in the exact form the check looks for', () => {
    const crib = figureCrib(JUNE);
    expect(crib).toContain('total spend: ₹8,959.49');
    expect(crib).toContain('total income: ₹10,926.72');
    expect(crib).toContain('savings rate: 18%');
  });

  it('sends aggregates and nothing that could identify a transaction', () => {
    const message = buildUserMessage(JUNE);
    expect(message).toContain('June 2026');
    expect(message).toContain('8959.49');
    // No transaction ids and no dates — the stats block carries neither.
    expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('forbids inventing figures in as many words', () => {
    expect(SYSTEM_PROMPT).toContain('Never calculate a new figure');
  });

  it('tells the model exactly what was wrong when it is asked to try again', () => {
    const correction = buildCorrectionMessage([
      '₹612.40 is not one of the figures you were given.',
    ]);
    expect(correction).toContain('₹612.40');
    expect(correction).toContain('Rewrite the whole recap');
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe('renderFallback', () => {
  it('states the figures without pretending to be prose about them', () => {
    const text = renderFallback(JUNE);
    expect(text).toContain('₹8,959.49');
    expect(text).toContain('₹10,926.72');
    expect(text).toContain('18%');
    expect(text).toContain('PRESTIGE PROPERTY MGMT');
    expect(text).toContain('NETFLIX went up');
  });

  it('passes its own figure check, so the fallback can never be the wrong one', () => {
    const check = checkFigures(renderFallback(JUNE), JUNE);
    const invented = check.problems.filter((p) => p.includes('not one of the figures'));
    expect(invented).toEqual([]);
  });

  it('says nothing about a savings rate when there is no income', () => {
    const text = renderFallback({ ...JUNE, income: 0, savingsRate: null });
    expect(text).not.toContain('savings rate');
  });
});

// ---------------------------------------------------------------------------
// The Anthropic summarizer
// ---------------------------------------------------------------------------

function fakeClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 400, output_tokens: 300 },
    stop_reason: 'end_turn',
  };
}

describe('AnthropicMonthlySummarizer', () => {
  it('costs exactly one call for one summary', async () => {
    const create = vi.fn().mockResolvedValue(textResponse(goodSummary()));
    const result = await new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(
      JUNE,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ source: 'model', calls: 1, rejections: [] });
    expect(result.content).toContain('₹8,959.49');
  });

  it('sends the stats and caches the system prompt', async () => {
    const create = vi.fn().mockResolvedValue(textResponse(goodSummary()));
    await new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(JUNE);

    const request = create.mock.calls[0][0];
    expect(request.model).toBe(SUMMARY_MODEL);
    expect(request.system[0].text).toBe(SYSTEM_PROMPT);
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(request.messages).toHaveLength(1);
  });

  it('retries once, showing the model its own draft and what was wrong with it', async () => {
    const bad = goodSummary('Dining came to ₹612.40. ');
    const create = vi
      .fn()
      .mockResolvedValueOnce(textResponse(bad))
      .mockResolvedValueOnce(textResponse(goodSummary()));

    const result = await new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(
      JUNE,
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ source: 'model', calls: 2 });
    expect(result.rejections.join(' ')).toContain('₹612.40');

    const second = create.mock.calls[1][0];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toMatchObject({ role: 'assistant', content: bad });
    expect(second.messages[2].content).toContain('₹612.40');
  });

  it('falls back to the figures rather than publish a third guess', async () => {
    const bad = goodSummary('Dining came to ₹612.40. ');
    const create = vi.fn().mockResolvedValue(textResponse(bad));

    const result = await new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(
      JUNE,
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('fallback');
    expect(result.content).toBe(renderFallback(JUNE));
    expect(result.rejections.length).toBeGreaterThan(0);
  });

  it('never returns text that fails its own check', async () => {
    const create = vi.fn().mockResolvedValue(textResponse(goodSummary('And ₹612.40 of dining. ')));
    const result = await new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(
      JUNE,
    );

    const invented = checkFigures(result.content, JUNE).problems.filter((p) =>
      p.includes('not one of the figures'),
    );
    expect(invented).toEqual([]);
  });

  it('reports usage for cost tracking', async () => {
    const onUsage = vi.fn();
    const create = vi.fn().mockResolvedValue(textResponse(goodSummary()));
    await new AnthropicMonthlySummarizer({ client: fakeClient(create), onUsage }).summarize(JUNE);

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 400, outputTokens: 300 });
  });

  it('raises a configuration error rather than quietly producing nothing', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new Error('Could not resolve authentication method. Expected one of...'));

    await expect(
      new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(JUNE),
    ).rejects.toBeInstanceOf(SummarizerConfigurationError);
  });

  it('lets a transient failure surface instead of dressing it up as a summary', async () => {
    const create = vi.fn().mockRejectedValue(new Error('socket hang up'));

    await expect(
      new AnthropicMonthlySummarizer({ client: fakeClient(create) }).summarize(JUNE),
    ).rejects.toThrow('socket hang up');
  });
});

describe('countWords', () => {
  it('counts words, not characters or whitespace', () => {
    expect(countWords('  one   two\nthree ')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});
