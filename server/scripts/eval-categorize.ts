/**
 * Measures LLM categorization accuracy against the hand-labeled set in
 * src/services/ai/eval-set.ts.
 *
 * Makes real Anthropic API calls and therefore costs real money — a couple of
 * requests at the batch size configured in categorize.ts.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:categorize --workspace server
 */
import 'dotenv/config';

import {
  AnthropicMerchantCategorizer,
  CategorizerConfigurationError,
  LOW_CONFIDENCE_THRESHOLD,
  type CategorizationOutcome,
} from '../src/services/ai/categorize';
import { EVAL_SET, type EvalCase } from '../src/services/ai/eval-set';

interface Scored extends EvalCase {
  got: CategorizationOutcome;
  correct: boolean;
  /** An abstention on an ambiguous merchant is a defensible answer, not a hit. */
  abstained: boolean;
}

async function main() {
  const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const categorizer = new AnthropicMerchantCategorizer({
    onUsage: (u) => {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.requests += 1;
    },
  });

  const started = Date.now();
  const outcomes = await categorizer.categorize(EVAL_SET.map((c) => c.merchant));
  const elapsed = Date.now() - started;

  // Belt and braces on top of the fatal-error path: an accuracy figure computed
  // from zero model calls is not a result, it is a misconfiguration wearing one.
  if (usage.requests === 0) {
    throw new Error('No model calls were made — refusing to report an accuracy figure.');
  }

  const byMerchant = new Map(outcomes.map((o) => [o.merchant, o]));
  const scored: Scored[] = EVAL_SET.map((testCase) => {
    const got = byMerchant.get(testCase.merchant)!;
    return {
      ...testCase,
      got,
      correct: got.category === testCase.expected,
      abstained: got.category === 'UNCATEGORIZED',
    };
  });

  const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`);
  const group = (difficulty: EvalCase['difficulty']) =>
    scored.filter((s) => s.difficulty === difficulty);

  console.log(`\nModel calls   ${usage.requests}`);
  console.log(`Tokens        ${usage.inputTokens} in / ${usage.outputTokens} out`);
  console.log(`Elapsed       ${(elapsed / 1000).toFixed(1)}s`);

  console.log('\n--- Accuracy ---');
  const overallCorrect = scored.filter((s) => s.correct).length;
  console.log(
    `Overall            ${pct(overallCorrect, scored.length)}  (${overallCorrect}/${scored.length})`,
  );
  (['unresolved', 'control', 'abstain'] as const).forEach((difficulty) => {
    const rows = group(difficulty);
    const hits = rows.filter((s) => s.correct).length;
    console.log(`  ${difficulty.padEnd(16)} ${pct(hits, rows.length)}  (${hits}/${rows.length})`);
  });

  // The metric that matters most: a wrong category silently corrupts totals,
  // whereas an abstention just routes the merchant to a human.
  const decided = scored.filter((s) => !s.abstained);
  const wrong = decided.filter((s) => !s.correct);
  console.log(`\nPrecision when it commits  ${pct(decided.length - wrong.length, decided.length)}`);
  console.log(`Abstention rate            ${pct(scored.length - decided.length, scored.length)}`);

  const meanConfidence = (rows: Scored[]) =>
    rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.got.confidence, 0) / rows.length;
  console.log('\n--- Calibration ---');
  console.log(
    `Mean confidence when right ${meanConfidence(decided.filter((s) => s.correct)).toFixed(2)}`,
  );
  console.log(`Mean confidence when wrong ${meanConfidence(wrong).toFixed(2)}`);
  console.log(
    `Below the ${LOW_CONFIDENCE_THRESHOLD} review threshold  ${
      scored.filter((s) => s.got.confidence < LOW_CONFIDENCE_THRESHOLD).length
    }/${scored.length}`,
  );

  if (wrong.length > 0) {
    console.log('\n--- Incorrect ---');
    wrong.forEach((s) => {
      console.log(
        `  ${s.merchant.padEnd(24)} got ${s.got.category.padEnd(16)} want ${s.expected.padEnd(16)} conf ${s.got.confidence.toFixed(2)}`,
      );
      console.log(`      ${s.got.reason}`);
    });
  }

  const abstentions = scored.filter((s) => s.abstained && s.expected !== 'UNCATEGORIZED');
  if (abstentions.length > 0) {
    console.log('\n--- Abstained (routed to review rather than guessed) ---');
    abstentions.forEach((s) => console.log(`  ${s.merchant.padEnd(24)} want ${s.expected}`));
  }
}

main().catch((error) => {
  if (error instanceof CategorizerConfigurationError) {
    console.error(`\nCannot run the eval: ${error.message}`);
    console.error('Set ANTHROPIC_API_KEY in server/.env and re-run.');
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
