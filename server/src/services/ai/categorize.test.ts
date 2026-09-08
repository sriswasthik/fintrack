import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { CATEGORIES } from '../rules/categories';
import {
  AnthropicMerchantCategorizer,
  CategorizerConfigurationError,
  LOW_CONFIDENCE_THRESHOLD,
  MERCHANT_BATCH_SIZE,
  SYSTEM_PROMPT,
  batched,
  reconcileVerdicts,
} from './categorize';

describe('the system prompt', () => {
  it('lists every category in the taxonomy', () => {
    CATEGORIES.forEach((category) => expect(SYSTEM_PROMPT).toContain(category));
  });

  it('forbids inventing a category', () => {
    expect(SYSTEM_PROMPT).toMatch(/MUST choose from exactly this list/i);
  });

  it('tells the model that abstaining is allowed', () => {
    expect(SYSTEM_PROMPT).toMatch(/UNCATEGORIZED when you genuinely cannot tell/i);
  });

  it('reserves REFUND for the engine rather than the model', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never return REFUND/i);
  });
});

describe('batched', () => {
  it('splits into chunks of the given size', () => {
    expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(batched([], 20)).toEqual([]);
  });

  it('keeps a short list in one chunk', () => {
    expect(batched([1, 2], 20)).toEqual([[1, 2]]);
  });
});

describe('reconcileVerdicts', () => {
  const asked = ['MUJI', 'TESCO'];

  it('passes a well-formed verdict through', () => {
    const outcomes = reconcileVerdicts(asked, [
      { merchant: 'MUJI', category: 'SHOPPING', confidence: 0.9, reason: 'Homeware retailer' },
      { merchant: 'TESCO', category: 'GROCERIES', confidence: 0.95, reason: 'UK supermarket' },
    ]);

    expect(outcomes).toEqual([
      { merchant: 'MUJI', category: 'SHOPPING', confidence: 0.9, reason: 'Homeware retailer' },
      { merchant: 'TESCO', category: 'GROCERIES', confidence: 0.95, reason: 'UK supermarket' },
    ]);
  });

  it('returns one outcome per merchant asked, in order', () => {
    const outcomes = reconcileVerdicts(asked, []);
    expect(outcomes.map((o) => o.merchant)).toEqual(asked);
  });

  it('rejects a category outside the taxonomy rather than storing it', () => {
    const outcomes = reconcileVerdicts(
      ['MUJI'],
      [{ merchant: 'MUJI', category: 'HOMEWARE' as never, confidence: 0.9, reason: 'Invented' }],
    );

    expect(outcomes[0]).toMatchObject({ category: 'UNCATEGORIZED', confidence: 0, rejected: true });
  });

  it.each([
    ['a confidence above 1', 1.4],
    ['a negative confidence', -0.2],
  ])('rejects %s', (_label, confidence) => {
    const outcomes = reconcileVerdicts(
      ['MUJI'],
      [{ merchant: 'MUJI', category: 'SHOPPING', confidence, reason: 'x' }],
    );
    expect(outcomes[0].rejected).toBe(true);
  });

  it('rejects a verdict missing a field', () => {
    const outcomes = reconcileVerdicts(
      ['MUJI'],
      [{ merchant: 'MUJI', category: 'SHOPPING' } as never],
    );
    expect(outcomes[0].rejected).toBe(true);
  });

  it('rejects REFUND, which is decided from amounts rather than by the model', () => {
    const outcomes = reconcileVerdicts(
      ['ZARA'],
      [{ merchant: 'ZARA', category: 'REFUND', confidence: 0.9, reason: 'Looks like a return' }],
    );

    expect(outcomes[0]).toMatchObject({ category: 'UNCATEGORIZED', rejected: true });
    expect(outcomes[0].reason).toMatch(/decided from transaction amounts/i);
  });

  it('marks a merchant the model skipped', () => {
    const outcomes = reconcileVerdicts(asked, [
      { merchant: 'MUJI', category: 'SHOPPING', confidence: 0.9, reason: 'ok' },
    ]);

    expect(outcomes[1]).toMatchObject({
      merchant: 'TESCO',
      category: 'UNCATEGORIZED',
      rejected: true,
    });
  });

  it('ignores a merchant nobody asked about', () => {
    const outcomes = reconcileVerdicts(
      ['MUJI'],
      [
        { merchant: 'MUJI', category: 'SHOPPING', confidence: 0.9, reason: 'ok' },
        { merchant: 'SOMETHING ELSE', category: 'DINING', confidence: 0.9, reason: 'unasked' },
      ],
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].merchant).toBe('MUJI');
  });

  it('keeps the first of two answers for the same merchant', () => {
    const outcomes = reconcileVerdicts(
      ['MUJI'],
      [
        { merchant: 'MUJI', category: 'SHOPPING', confidence: 0.9, reason: 'first' },
        { merchant: 'MUJI', category: 'DINING', confidence: 0.9, reason: 'second' },
      ],
    );

    expect(outcomes[0].category).toBe('SHOPPING');
  });

  it('accepts an honest UNCATEGORIZED without marking it rejected', () => {
    const outcomes = reconcileVerdicts(
      ['WWWSTORE'],
      [
        {
          merchant: 'WWWSTORE',
          category: 'UNCATEGORIZED',
          confidence: 0.2,
          reason: 'Uninformative',
        },
      ],
    );

    expect(outcomes[0]).toMatchObject({ category: 'UNCATEGORIZED', confidence: 0.2 });
    expect(outcomes[0].rejected).toBeUndefined();
  });
});

/** A stand-in for the Anthropic client, so no network call is made. */
function fakeClient(parse: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { parse } } as unknown as Anthropic;
}

function parsedResponse(results: unknown[], usage = { input_tokens: 10, output_tokens: 20 }) {
  return { parsed_output: { results }, usage, stop_reason: 'end_turn' };
}

describe('AnthropicMerchantCategorizer', () => {
  it('sends the merchants and returns their verdicts', async () => {
    const parse = vi
      .fn()
      .mockResolvedValue(
        parsedResponse([
          { merchant: 'MUJI', category: 'SHOPPING', confidence: 0.9, reason: 'Homeware' },
        ]),
      );
    const categorizer = new AnthropicMerchantCategorizer({ client: fakeClient(parse) });

    const outcomes = await categorizer.categorize(['MUJI']);

    expect(outcomes[0]).toMatchObject({ category: 'SHOPPING', confidence: 0.9 });
    const request = parse.mock.calls[0][0];
    expect(request.model).toBe('claude-opus-5');
    expect(request.system[0].text).toBe(SYSTEM_PROMPT);
    expect(request.messages[0].content).toContain('MUJI');
  });

  it('sends only the merchant string — no amounts, dates or descriptions', async () => {
    const parse = vi.fn().mockResolvedValue(parsedResponse([]));
    await new AnthropicMerchantCategorizer({ client: fakeClient(parse) }).categorize(['MUJI']);

    const serialized = JSON.stringify(parse.mock.calls[0][0]);
    expect(serialized).toContain('MUJI');
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('constrains the output with a schema and caches the system prompt', async () => {
    const parse = vi.fn().mockResolvedValue(parsedResponse([]));
    await new AnthropicMerchantCategorizer({ client: fakeClient(parse) }).categorize(['MUJI']);

    const request = parse.mock.calls[0][0];
    expect(request.output_config.format).toBeDefined();
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it(`batches at ${MERCHANT_BATCH_SIZE} merchants per call`, async () => {
    const parse = vi.fn().mockResolvedValue(parsedResponse([]));
    const merchants = Array.from({ length: 45 }, (_, i) => `MERCHANT ${i}`);

    const outcomes = await new AnthropicMerchantCategorizer({
      client: fakeClient(parse),
    }).categorize(merchants);

    expect(parse).toHaveBeenCalledTimes(3);
    expect(parse.mock.calls[0][0].messages[0].content).toContain('MERCHANT 0');
    expect(outcomes).toHaveLength(45);
  });

  it('makes no call at all for an empty list', async () => {
    const parse = vi.fn();
    const outcomes = await new AnthropicMerchantCategorizer({
      client: fakeClient(parse),
    }).categorize([]);

    expect(parse).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('reports token usage for cost tracking', async () => {
    const parse = vi
      .fn()
      .mockResolvedValue(parsedResponse([], { input_tokens: 512, output_tokens: 128 }));
    const onUsage = vi.fn();

    await new AnthropicMerchantCategorizer({ client: fakeClient(parse), onUsage }).categorize([
      'MUJI',
    ]);

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 512, outputTokens: 128, merchants: 1 });
  });

  it('leaves merchants unresolved when the response cannot be parsed', async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({
        parsed_output: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'refusal',
      });

    const outcomes = await new AnthropicMerchantCategorizer({
      client: fakeClient(parse),
    }).categorize(['MUJI']);

    expect(outcomes[0]).toMatchObject({ category: 'UNCATEGORIZED', confidence: 0, rejected: true });
    expect(outcomes[0].reason).toMatch(/refusal/);
  });

  it('survives an API failure without throwing, so an import is never aborted', async () => {
    const parse = vi.fn().mockRejectedValue(new Anthropic.APIConnectionError({ message: 'down' }));

    const outcomes = await new AnthropicMerchantCategorizer({
      client: fakeClient(parse),
    }).categorize(['MUJI', 'TESCO']);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.category === 'UNCATEGORIZED' && o.rejected)).toBe(true);
  });

  it('keeps the good batches when only one of several fails', async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce(parsedResponse([]))
      .mockRejectedValueOnce(new Error('boom'));
    const merchants = Array.from({ length: 25 }, (_, i) => `MERCHANT ${i}`);

    const outcomes = await new AnthropicMerchantCategorizer({
      client: fakeClient(parse),
    }).categorize(merchants);

    expect(outcomes).toHaveLength(25);
    expect(outcomes[24].reason).toMatch(/failed/i);
  });
});

describe('configuration failures are fatal, transient ones are not', () => {
  // Failing softly on a bad credential would silently disable categorization for
  // every merchant forever, and look identical in the data to "the model had no
  // idea about any of these". An eval run that way reports a real-looking
  // accuracy figure computed from zero model calls.
  it.each([
    [
      'no credential at all',
      new Error(
        'Could not resolve authentication method. Expected one of apiKey, authToken to be set',
      ),
    ],
    [
      'a rejected key',
      new Anthropic.AuthenticationError(401, new Headers(), 'bad key', new Headers()),
    ],
    [
      'a forbidden key',
      new Anthropic.PermissionDeniedError(403, new Headers(), 'no access', new Headers()),
    ],
    [
      'an unavailable model',
      new Anthropic.NotFoundError(404, new Headers(), 'no model', new Headers()),
    ],
  ])('throws on %s', async (_label, error) => {
    const parse = vi.fn().mockRejectedValue(error);
    const categorizer = new AnthropicMerchantCategorizer({ client: fakeClient(parse) });

    await expect(categorizer.categorize(['MUJI'])).rejects.toBeInstanceOf(
      CategorizerConfigurationError,
    );
  });

  it.each([
    ['a connection failure', new Anthropic.APIConnectionError({ message: 'socket hang up' })],
    ['a rate limit', new Anthropic.RateLimitError(429, new Headers(), 'slow down', new Headers())],
    [
      'a server error',
      new Anthropic.InternalServerError(500, new Headers(), 'oops', new Headers()),
    ],
  ])('leaves merchants unresolved on %s instead of throwing', async (_label, error) => {
    const parse = vi.fn().mockRejectedValue(error);
    const categorizer = new AnthropicMerchantCategorizer({ client: fakeClient(parse) });

    const outcomes = await categorizer.categorize(['MUJI']);
    expect(outcomes[0]).toMatchObject({ category: 'UNCATEGORIZED', rejected: true });
  });
});

describe('the low-confidence threshold', () => {
  it('sits where a coin-flip answer still reaches a human', () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.5);
    expect(LOW_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});
