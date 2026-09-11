/**
 * Measures categorization accuracy against the hand-labeled set in
 * src/services/ai/eval-set.ts.
 *
 * Scores the pipeline as it actually runs (PROJECT_CONTEXT.md §4): the
 * deterministic rule engine decides first, and only what it leaves
 * UNCATEGORIZED is sent to the model. Measuring the model alone would be
 * measuring something the app never does — and would flatter or punish it for
 * merchants a keyword list already settles for free.
 *
 * Both halves are still reported separately underneath, because they fail
 * differently: a wrong rule is a bug in a file, and a wrong model answer is a
 * calibration problem.
 *
 * Makes real Anthropic API calls and therefore costs real money — one or two
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
import type { Category } from '../src/generated/prisma/enums';
import { DEFAULT_RULES } from '../src/services/rules/defaults';
import { matchRule, orderRules, type EngineRule } from '../src/services/rules/engine';

/** How a merchant's final category was arrived at. */
type Decider = 'rule' | 'model';

interface Scored extends EvalCase {
  decidedBy: Decider;
  actual: Category;
  confidence: number;
  reason: string;
  correct: boolean;
  /** An abstention on an ambiguous merchant is a defensible answer, not a hit. */
  abstained: boolean;
}

/** The built-in rules, in the order the engine applies them. */
const ordered: EngineRule[] = orderRules(
  DEFAULT_RULES.map((rule, i) => ({
    id: `builtin-${String(i).padStart(4, '0')}`,
    pattern: rule.pattern,
    category: rule.category,
    priority: rule.priority,
    userId: null,
    learnedFromOverride: false,
  })),
);

async function main() {
  // Pass 1: the rule engine, exactly as the import pipeline runs it.
  const ruled = new Map<string, EngineRule>();
  const forModel: string[] = [];
  for (const testCase of EVAL_SET) {
    const rule = matchRule(testCase.merchant, ordered);
    if (rule) ruled.set(testCase.merchant, rule);
    else forModel.push(testCase.merchant);
  }

  // Pass 2: the model, on what is left.
  const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const categorizer = new AnthropicMerchantCategorizer({
    onUsage: (u) => {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.requests += 1;
    },
  });

  const started = Date.now();
  const outcomes = forModel.length > 0 ? await categorizer.categorize(forModel) : [];
  const elapsed = Date.now() - started;

  // Belt and braces on top of the fatal-error path: an accuracy figure computed
  // from zero model calls is not a result, it is a misconfiguration wearing one.
  if (forModel.length > 0 && usage.requests === 0) {
    throw new Error('No model calls were made — refusing to report an accuracy figure.');
  }

  const byMerchant = new Map<string, CategorizationOutcome>(outcomes.map((o) => [o.merchant, o]));
  const scored: Scored[] = EVAL_SET.map((testCase) => {
    const rule = ruled.get(testCase.merchant);
    if (rule) {
      return {
        ...testCase,
        decidedBy: 'rule',
        actual: rule.category,
        confidence: 1,
        reason: `Built-in rule /${rule.pattern}/`,
        correct: rule.category === testCase.expected,
        abstained: false,
      };
    }
    const got = byMerchant.get(testCase.merchant)!;
    return {
      ...testCase,
      decidedBy: 'model',
      actual: got.category,
      confidence: got.confidence,
      reason: got.reason,
      correct: got.category === testCase.expected,
      abstained: got.category === 'UNCATEGORIZED',
    };
  });

  const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`);
  const hits = (rows: Scored[]) => rows.filter((s) => s.correct).length;

  console.log(`\nModel calls   ${usage.requests}`);
  console.log(`Tokens        ${usage.inputTokens} in / ${usage.outputTokens} out`);
  console.log(`Elapsed       ${(elapsed / 1000).toFixed(1)}s`);

  console.log('\n--- Combined accuracy (rules, then the model on the rest) ---');
  const overall = hits(scored);
  console.log(`Overall            ${pct(overall, scored.length)}  (${overall}/${scored.length})`);

  const byRule = scored.filter((s) => s.decidedBy === 'rule');
  const byModel = scored.filter((s) => s.decidedBy === 'model');
  console.log(
    `  settled by rule  ${pct(hits(byRule), byRule.length)}  (${hits(byRule)}/${byRule.length})`,
  );
  console.log(
    `  settled by model ${pct(hits(byModel), byModel.length)}  (${hits(byModel)}/${byModel.length})`,
  );

  console.log('\n--- By difficulty ---');
  (['unresolved', 'control', 'abstain'] as const).forEach((difficulty) => {
    const rows = scored.filter((s) => s.difficulty === difficulty);
    console.log(
      `  ${difficulty.padEnd(16)} ${pct(hits(rows), rows.length)}  (${hits(rows)}/${rows.length})`,
    );
  });

  // The metric that matters most: a wrong category silently corrupts totals,
  // whereas an abstention just routes the merchant to a human.
  const decided = scored.filter((s) => !s.abstained);
  const wrong = decided.filter((s) => !s.correct);
  console.log(`\nPrecision when it commits  ${pct(decided.length - wrong.length, decided.length)}`);
  console.log(`Abstention rate            ${pct(scored.length - decided.length, scored.length)}`);

  const meanConfidence = (rows: Scored[]) =>
    rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.confidence, 0) / rows.length;
  console.log('\n--- Calibration (model answers only) ---');
  const modelDecided = byModel.filter((s) => !s.abstained);
  const modelWrong = modelDecided.filter((s) => !s.correct);
  console.log(
    `Mean confidence when right ${meanConfidence(modelDecided.filter((s) => s.correct)).toFixed(2)}`,
  );
  console.log(`Mean confidence when wrong ${meanConfidence(modelWrong).toFixed(2)}`);
  console.log(
    `Below the ${LOW_CONFIDENCE_THRESHOLD} review threshold  ${
      byModel.filter((s) => s.confidence < LOW_CONFIDENCE_THRESHOLD).length
    }/${byModel.length}`,
  );

  if (wrong.length > 0) {
    console.log('\n--- Incorrect ---');
    wrong.forEach((s) => {
      console.log(
        `  [${s.decidedBy}] ${s.merchant.padEnd(28)} got ${s.actual.padEnd(16)} want ${s.expected.padEnd(16)} conf ${s.confidence.toFixed(2)}`,
      );
      console.log(`      ${s.reason}`);
    });
  }

  const abstentions = scored.filter((s) => s.abstained && s.expected !== 'UNCATEGORIZED');
  if (abstentions.length > 0) {
    console.log('\n--- Abstained (routed to review rather than guessed) ---');
    abstentions.forEach((s) => console.log(`  ${s.merchant.padEnd(28)} want ${s.expected}`));
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
