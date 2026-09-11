/**
 * The accuracy report.
 *
 * Runs the whole deterministic pipeline over the Phase-1 synthetic dataset —
 * parse, normalize, dedup, rule engine, anomaly detection — scores it against
 * the ground truth the generator recorded, and writes docs/ACCURACY_REPORT.md.
 *
 * Deliberately database-free and model-free, so the numbers are reproducible by
 * anyone with a checkout: the same input always produces the same report, and a
 * change to the rules or the normalizer shows up here immediately.
 *
 * `npm run accuracy:report --workspace server`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  generateDataset,
  MONTHLY_BILL_MERCHANTS,
  transactionsByEdgeCase,
  type EdgeCase,
  type GeneratedTransaction,
} from '../prisma/seed-data';
import type { Category } from '../src/generated/prisma/enums';
import {
  detectAnomalies,
  findRecurringCharges,
  type AnomalyTransaction,
  type DetectedAnomaly,
} from '../src/services/anomalies/detect';
import { HEADER_PRESETS, parseTransactions } from '../src/services/parsing/csv';
import { flagDuplicates } from '../src/services/parsing/dedup';
import { DEFAULT_RULES } from '../src/services/rules/defaults';
import { formatINR } from '../src/utils/currency';
import { runEngine, type EngineRule, type EngineTransaction } from '../src/services/rules/engine';

const ROOT = join(__dirname, '..', '..');
const REPORT_PATH = join(ROOT, 'docs', 'ACCURACY_REPORT.md');
const CSV_PATH = join(ROOT, 'test-data', 'synthetic_transactions.csv');

const pct = (n: number, of: number): string => (of === 0 ? '—' : `${((n / of) * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// Run the pipeline
// ---------------------------------------------------------------------------

const dataset = generateDataset();
const planted = transactionsByEdgeCase(dataset);
const rowsBy = (edgeCase: EdgeCase): GeneratedTransaction[] => planted.get(edgeCase) ?? [];
const byRow = new Map(dataset.map((t) => [String(t.row), t]));

const generic = HEADER_PRESETS.find((preset) => preset.id === 'generic')!;
const parsed = parseTransactions(readFileSync(CSV_PATH, 'utf8'), generic.mapping);
const flagged = flagDuplicates(parsed.rows, []);

const rules: EngineRule[] = DEFAULT_RULES.map((rule, i) => ({
  // Padded so the ids sort in array order. Unpadded, 'builtin-243' sorts before
  // 'builtin-84' and the priority tiebreak silently reorders the rule set — the
  // accident that hid `^SPENCERS` shadowing `^SPENCERS HYPER` until Phase 14.
  id: `builtin-${String(i).padStart(4, '0')}`,
  pattern: rule.pattern,
  category: rule.category,
  priority: rule.priority,
  userId: null,
  learnedFromOverride: false,
}));

const engineInput: EngineTransaction[] = dataset.map((t) => ({
  id: String(t.row),
  accountId: t.account,
  date: t.date,
  normalizedMerchant: t.normalizedMerchant,
  amount: t.amount,
  category: t.manualCategory ?? ('UNCATEGORIZED' as Category),
  confidence: t.manualCategory ? 1 : 0,
  source: t.manualCategory ? 'MANUAL' : 'RULE',
}));

const outcome = runEngine(engineInput, rules);
const decided = new Map(outcome.results.map((r) => [r.transactionId, r]));

// ---------------------------------------------------------------------------
// 1. Categorization accuracy
// ---------------------------------------------------------------------------

interface Scored {
  transaction: GeneratedTransaction;
  expected: Category;
  actual: Category;
  verdict: 'correct' | 'unresolved' | 'incorrect';
}

/** Rows a human had already corrected are not auto-categorized, so they are out. */
const auto = dataset.filter((t) => !t.manualCategory);

const scored: Scored[] = auto.map((transaction) => {
  const actual = decided.get(String(transaction.row))!.category;
  const expected = transaction.expectedCategory;
  return {
    transaction,
    expected,
    actual,
    verdict:
      actual === expected ? 'correct' : actual === 'UNCATEGORIZED' ? 'unresolved' : 'incorrect',
  };
});

const correct = scored.filter((s) => s.verdict === 'correct');
const unresolved = scored.filter((s) => s.verdict === 'unresolved');
const incorrect = scored.filter((s) => s.verdict === 'incorrect');

const byCategory = new Map<Category, { total: number; correct: number }>();
scored.forEach((s) => {
  const entry = byCategory.get(s.expected) ?? { total: 0, correct: 0 };
  entry.total += 1;
  if (s.verdict === 'correct') entry.correct += 1;
  byCategory.set(s.expected, entry);
});

const unresolvedMerchants = new Map<string, { count: number; expected: Category }>();
unresolved.forEach((s) => {
  const entry = unresolvedMerchants.get(s.transaction.normalizedMerchant) ?? {
    count: 0,
    expected: s.expected,
  };
  entry.count += 1;
  unresolvedMerchants.set(s.transaction.normalizedMerchant, entry);
});

// ---------------------------------------------------------------------------
// 2. Anomaly-flag precision
// ---------------------------------------------------------------------------

const months = [...new Set(dataset.map((t) => t.date.slice(0, 7)))].sort();
/** What each purchase got back, from the links Phase 3 worked out (§8 case 2). */
const refundedByPurchase = new Map(
  outcome.refundLinks.map((link) => [link.purchaseId, -byRow.get(link.refundId)!.amount]),
);

const anomalyRows: AnomalyTransaction[] = dataset.map((t) => ({
  id: String(t.row),
  date: t.date,
  amount: t.amount,
  normalizedMerchant: t.normalizedMerchant,
  category: decided.get(String(t.row))!.category,
  ...(refundedByPurchase.has(String(t.row))
    ? { refunded: refundedByPurchase.get(String(t.row)) }
    : {}),
}));
const flags: DetectedAnomaly[] = months.flatMap((month) => detectAnomalies(anomalyRows, { month }));

/**
 * Ground truth for a flag.
 *
 * A flag is *planted* when it traces to an edge case the generator put there on
 * purpose. Everything else is reported as *unplanted* rather than as "wrong":
 * the detectors are deterministic, so every flag is statistically true by
 * construction, and whether an unplanted one is worth a person's attention is a
 * judgement a reader should make from the explanation, not one this script can
 * make for them.
 */
function tracesToPlanted(flag: DetectedAnomaly): string | null {
  const row = flag.transactionId ? byRow.get(flag.transactionId) : undefined;

  if (flag.type === 'UNUSUAL_AMOUNT' && row?.edgeCases.includes('large-one-off')) {
    return 'large-one-off';
  }
  if (
    flag.type === 'SUBSCRIPTION_PRICE_INCREASE' &&
    row?.edgeCases.includes('subscription-price-change')
  ) {
    return 'subscription-price-change';
  }
  if (flag.type === 'NEW_RECURRING_CHARGE' && row?.edgeCases.includes('new-subscription')) {
    return 'new-subscription';
  }
  if (flag.type === 'CATEGORY_SPEND_SPIKE') {
    // A spike is planted when a planted one-off is what caused it.
    const cause = rowsBy('large-one-off').find(
      (one) =>
        one.date.slice(0, 7) === flag.month && flag.explanation.startsWith(one.expectedCategory),
    );
    if (cause) return 'large-one-off (category spike)';
  }
  return null;
}

const flagVerdicts = flags.map((flag) => ({ flag, planted: tracesToPlanted(flag) }));
const plantedFlags = flagVerdicts.filter((f) => f.planted !== null);
const unplantedFlags = flagVerdicts.filter((f) => f.planted === null);

/** Every anomaly the generator planted, and whether detection found it. */
const expectedAnomalies = [
  ...rowsBy('large-one-off').map((t) => ({
    label: `${t.normalizedMerchant} ${formatINR(t.amount)} (${t.date})`,
    kind: 'large one-off',
    found: flags.some((f) => f.type === 'UNUSUAL_AMOUNT' && f.transactionId === String(t.row)),
  })),
  ...(() => {
    const charges = rowsBy('subscription-price-change');
    const raised = charges.find((c) => c.amount !== charges[0].amount);
    return raised
      ? [
          {
            label: `${raised.normalizedMerchant} ${formatINR(charges[0].amount)} → ${formatINR(raised.amount)} (${raised.date})`,
            kind: 'subscription price change',
            found: flags.some(
              (f) =>
                f.type === 'SUBSCRIPTION_PRICE_INCREASE' && f.transactionId === String(raised.row),
            ),
          },
        ]
      : [];
  })(),
  ...(() => {
    const [first, second] = rowsBy('new-subscription');
    return second
      ? [
          {
            label: `${first.normalizedMerchant} from ${first.date}`,
            kind: 'new recurring charge',
            found: flags.some(
              (f) => f.type === 'NEW_RECURRING_CHARGE' && f.transactionId === String(second.row),
            ),
          },
        ]
      : [];
  })(),
];

// ---------------------------------------------------------------------------
// 3. The false-positive metrics
// ---------------------------------------------------------------------------

/** Merchants the generator bills on a fixed day each month. */
const MONTHLY_BILLS = MONTHLY_BILL_MERCHANTS;

const classifiedRecurring = new Set(
  months.flatMap((month) =>
    findRecurringCharges(anomalyRows, { month }).map((charge) => charge.merchant),
  ),
);
const everydayMerchants = [
  ...new Set(
    anomalyRows.map((t) => t.normalizedMerchant).filter((m) => !MONTHLY_BILLS.includes(m)),
  ),
];
const everydayMisread = everydayMerchants.filter((m) => classifiedRecurring.has(m));
const billsFound = MONTHLY_BILLS.filter((m) => classifiedRecurring.has(m));

// Duplicate detection: planted sync glitches vs everything else.
const glitchRows = new Set(rowsBy('duplicate-glitch').map((t) => t.row));
const repeatRows = new Set(rowsBy('legit-repeat').map((t) => t.row));
const flaggedRows = flagged.filter((row) => row.duplicate !== null).map((row) => row.index);
const glitchesCaught = [...glitchRows].filter((row) => flaggedRows.includes(row));
const repeatsFlagged = flaggedRows.filter((row) => repeatRows.has(row));
const otherFlagged = flaggedRows.filter((row) => !glitchRows.has(row) && !repeatRows.has(row));

// ---------------------------------------------------------------------------
// Write the report
// ---------------------------------------------------------------------------

const table = (header: string[], rows: string[][]): string =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

const headline = pct(correct.length, scored.length);

const report = `# Accuracy Report

Generated by \`npm run accuracy:report --workspace server\` from
\`test-data/synthetic_transactions.csv\` (${dataset.length} transactions,
${months[0]} to ${months[months.length - 1]}).

The whole deterministic pipeline runs here — CSV parse, merchant
normalization, duplicate detection, the rule engine, anomaly detection — and is
scored against the ground truth \`server/prisma/seed-data.ts\` recorded when it
planted each edge case. No database and no model call, so the numbers are
reproducible from a bare checkout and any change to the rules or the normalizer
moves them immediately.

## Headline

${table(
  ['Metric', 'Result'],
  [
    ['**Auto-categorized correctly**', `**${headline}** (${correct.length} / ${scored.length})`],
    ['Miscategorized', `${pct(incorrect.length, scored.length)} (${incorrect.length})`],
    ['Left for review', `${pct(unresolved.length, scored.length)} (${unresolved.length})`],
    [
      'Planted anomalies detected',
      `${expectedAnomalies.filter((a) => a.found).length} / ${expectedAnomalies.length}`,
    ],
    ['Monthly bills identified', `${billsFound.length} / ${MONTHLY_BILLS.length}`],
    [
      'Everyday merchants misread as recurring',
      `${everydayMisread.length} / ${everydayMerchants.length}`,
    ],
  ],
)}

The denominator excludes the ${dataset.length - auto.length} rows that arrive already corrected by a human (§8 case 12) — those are not auto-categorized, so counting them either way would be measuring the wrong thing.

${
  incorrect.length === 0
    ? `**Nothing is miscategorized.** Every row the engine has an opinion about, it
gets right; the residual is rows it declines to guess on, which land in the
review queue exactly as §7 requires.`
    : `**${incorrect.length} row(s) are miscategorized** — the engine committed to an
answer and got it wrong, which is worse than declining to guess. The rest of the
residual is rows it left for review, exactly as §7 requires.

${table(
  ['Merchant', 'Got', 'Expected'],
  incorrect.map((s) => [
    `\`${s.transaction.normalizedMerchant}\``,
    s.actual,
    s.expected,
  ]),
)}`
}

## Where the remaining ${unresolved.length} go

${table(
  ['Merchant', 'Rows', 'Truth', 'Why it is not a rule'],
  [...unresolvedMerchants.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([merchant, entry]) => [
      `\`${merchant}\``,
      String(entry.count),
      entry.expected,
      'Undecidable from the string alone',
    ]),
)}

These are the ambiguous tail the LLM fallback (Phase 4) and the review queue
exist for. ${unresolvedMerchants.size === 1 ? 'One merchant-name rule' : `${unresolvedMerchants.size} merchant-name rules`} would clear ${unresolved.length === 1 ? 'it' : 'them'} and take the headline
to 100%, and it would mean nothing: that is memorising the test set, not
categorizing.

## By category

${table(
  ['Category', 'Rows', 'Correct', 'Rate'],
  [...byCategory.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([category, entry]) => [
      category,
      String(entry.total),
      String(entry.correct),
      pct(entry.correct, entry.total),
    ]),
)}

## Anomaly detection

Every anomaly the generator planted:

${table(
  ['Planted', 'Kind', 'Detected'],
  expectedAnomalies.map((a) => [a.label, a.kind, a.found ? 'yes' : '**no**']),
)}

${flags.length} flags were raised across ${months.length} months, of which ${plantedFlags.length} trace to a planted edge case (${pct(plantedFlags.length, flags.length)}). The other ${unplantedFlags.length} are listed below rather than counted as errors. The detectors are deterministic,
so every flag is statistically true by construction — whether an unplanted one
deserves a person's attention is a judgement to make from the explanation, not
one this script can make for anyone.

${
  unplantedFlags.length === 0
    ? '_No unplanted flags._'
    : table(
        ['Month', 'Type', 'Severity', 'Explanation'],
        unplantedFlags.map(({ flag }) => [
          flag.month,
          flag.type,
          flag.severity,
          flag.explanation.replace(/\|/g, '\\|'),
        ]),
      )
}

### Not crying wolf

The stronger claim, and the one §8 case 5 actually turns on: of the ${everydayMerchants.length + MONTHLY_BILLS.length} distinct merchants in the dataset, ${MONTHLY_BILLS.length} are billed on a fixed day each month by the generator. The recurring-charge classifier finds ${billsFound.length} of them and misreads ${everydayMisread.length} of the ${everydayMerchants.length} everyday merchants${everydayMisread.length === 0 ? ' — including the daily coffee, which appears in small, similar amounts across six months and is exactly what a subscription looks like from far enough away' : `: ${everydayMisread.join(', ')}`}.

## Duplicate detection (§8 case 5)

${table(
  ['Metric', 'Result'],
  [
    ['Planted sync glitches caught', `${glitchesCaught.length} / ${glitchRows.size}`],
    [
      'Legitimate same-day repeat pairs flagged for the user to resolve',
      `${repeatsFlagged.length} / ${repeatRows.size / 2}`,
    ],
    ['Anything else flagged', String(otherFlagged.length)],
  ],
)}

A legitimate repeat *is* flagged, and that is the intended behaviour rather than
a miss: two identical coffees an hour apart are indistinguishable from a sync
glitch in the data a bank gives you. The import preview asks; it does not decide
(§8 case 5).

## Pipeline health

${table(
  ['Stage', 'Result'],
  [
    ['CSV rows parsed', `${parsed.rows.length} / ${dataset.length}`],
    ['Parse errors', String(parsed.errors.length)],
    [
      'Merchants matching the recorded normalization',
      `${parsed.rows.filter((row, i) => row.normalizedMerchant === dataset[i].normalizedMerchant).length} / ${dataset.length}`,
    ],
    [
      'Transfer pairs found (§8 case 1)',
      `${outcome.transferPairs.length} / ${rowsBy('transfer-out').length}`,
    ],
    [
      'Refunds linked to their purchase (§8 case 2)',
      `${outcome.refundLinks.length} / ${rowsBy('refund').length}`,
    ],
  ],
)}

---

_Every row of \`docs/EDGE_CASES.md\` has a passing automated test; this report
is the quantitative half of the same claim._
`;

writeFileSync(REPORT_PATH, report);

console.log(`Auto-categorized correctly   ${headline} (${correct.length}/${scored.length})`);
console.log(`Miscategorized               ${incorrect.length}`);
console.log(`Left for review              ${unresolved.length}`);
console.log(
  `Planted anomalies detected   ${expectedAnomalies.filter((a) => a.found).length}/${expectedAnomalies.length}`,
);
console.log(`Flags raised                 ${flags.length} (${plantedFlags.length} planted)`);
console.log(`Monthly bills identified     ${billsFound.length}/${MONTHLY_BILLS.length}`);
console.log(`Everyday merchants misread   ${everydayMisread.length}/${everydayMerchants.length}`);
console.log(`\nWrote ${REPORT_PATH}`);
