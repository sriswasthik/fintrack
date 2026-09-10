/**
 * Builds the contents of test-data/synthetic_transactions.csv and
 * test-data/README.md. Kept separate from the script that writes them so a test
 * can compare the committed files against freshly generated content.
 */
import Papa from 'papaparse';

import { formatINR } from '../src/utils/currency';

import {
  ACCOUNTS,
  PENDING_FROM,
  REFERENCE_DATE,
  SEED,
  START_DATE,
  generateDataset,
  transactionsByEdgeCase,
  type EdgeCase,
  type GeneratedTransaction,
} from './seed-data';

/** The four generic bank-export columns. */
export interface CsvRow {
  date: string;
  description: string;
  amount: string;
  account: string;
}

export function toCsvRows(dataset = generateDataset()): CsvRow[] {
  return dataset.map((t) => ({
    date: t.date,
    description: t.description,
    amount: t.amount.toFixed(2),
    account: ACCOUNTS[t.account].name,
  }));
}

export function buildCsv(dataset = generateDataset()): string {
  return `${Papa.unparse(toCsvRows(dataset), {
    columns: ['date', 'description', 'amount', 'account'],
    newline: '\r\n',
  })}\r\n`;
}

// --------------------------------------------------------------------------
// README
// --------------------------------------------------------------------------

const money = (n: number) => formatINR(n);
const cell = (s: string) => s.replace(/\|/g, '\\|');
const account = (t: GeneratedTransaction) => ACCOUNTS[t.account].name;

function table(
  rows: GeneratedTransaction[],
  extra?: (t: GeneratedTransaction) => string,
  extraHeader?: string,
): string {
  const head = extraHeader
    ? `| Row | Date | Description | Amount | Account | ${extraHeader} |\n| ---: | --- | --- | ---: | --- | --- |`
    : '| Row | Date | Description | Amount | Account |\n| ---: | --- | --- | ---: | --- |';
  const body = rows
    .map((t) => {
      const base = `| ${t.row} | ${t.date} | \`${cell(t.description)}\` | ${money(t.amount)} | ${account(t)} |`;
      return extra ? `${base} ${extra(t)} |` : base;
    })
    .join('\n');
  return `${head}\n${body}`;
}

/** Groups the two halves of each pair (transfer, refund, FX, P2P, duplicate). */
function pairs(rows: GeneratedTransaction[]): GeneratedTransaction[] {
  return [...rows].sort((a, b) => {
    if (a.pairId !== b.pairId) return (a.pairId ?? '') < (b.pairId ?? '') ? -1 : 1;
    return a.row - b.row;
  });
}

export function buildReadme(dataset = generateDataset()): string {
  const byCase = transactionsByEdgeCase(dataset);
  const get = (c: EdgeCase) => byCase.get(c) ?? [];

  const months = [...new Set(dataset.map((t) => t.date.slice(0, 7)))].sort();
  const categoryCounts = new Map<string, number>();
  dataset.forEach((t) =>
    categoryCounts.set(t.expectedCategory, (categoryCounts.get(t.expectedCategory) ?? 0) + 1),
  );
  const accountCounts = new Map<string, number>();
  dataset.forEach((t) => accountCounts.set(account(t), (accountCounts.get(account(t)) ?? 0) + 1));

  const spend = dataset
    .filter((t) => t.expectedCategory !== 'INCOME' && t.expectedCategory !== 'TRANSFER')
    .reduce((s, t) => s + t.amount, 0);
  const income = -dataset
    .filter((t) => t.expectedCategory === 'INCOME')
    .reduce((s, t) => s + t.amount, 0);

  // -- merchant strings that a naive parser will get wrong -----------------
  const mangled = get('mangled-merchant');
  const mangledByMerchant = new Map<string, { example: string; count: number; firstRow: number }>();
  mangled.forEach((t) => {
    // Group by the merchant the normalizer should land on, so store/order ids
    // that vary row to row do not each get their own line.
    const seen = mangledByMerchant.get(t.normalizedMerchant);
    if (seen) seen.count += 1;
    else
      mangledByMerchant.set(t.normalizedMerchant, {
        example: t.rawMerchant,
        count: 1,
        firstRow: t.row,
      });
  });

  const subs = get('subscription');
  const subsByMerchant = new Map<string, GeneratedTransaction[]>();
  subs.forEach((t) => {
    const list = subsByMerchant.get(t.normalizedMerchant) ?? [];
    list.push(t);
    subsByMerchant.set(t.normalizedMerchant, list);
  });

  return `# Synthetic transaction dataset

\`synthetic_transactions.csv\` is a deliberately messy, six-month bank export for a
single fictional person with two accounts. It exists so every edge case in
[PROJECT_CONTEXT.md §8](../PROJECT_CONTEXT.md) has concrete rows to test against,
and so the dashboard has something realistic to render.

**Every row below is fictional.** No real person, account or card is involved.

## Files

| File | What it is |
| --- | --- |
| \`synthetic_transactions.csv\` | ${dataset.length} rows in a generic bank-export shape: \`date,description,amount,account\` |
| \`README.md\` | This file — the index from edge case to CSV row |

## Regenerating

Both files are generated, not hand-written:

\`\`\`bash
npm run test-data:export --workspace server
\`\`\`

The generator (\`server/prisma/seed-data.ts\`) is a pure function of a fixed seed
(\`${SEED}\`) and a fixed date window, so regenerating produces byte-identical
files and **the row numbers quoted below stay valid**. \`server/prisma/seed.ts\`
loads the same data into Postgres, so the CSV and the database always agree.
A test (\`server/prisma/seed-data.test.ts\`) fails if the committed files drift.

If you change the generator, re-run the command above and update this README's
row references — they are regenerated for you.

## Shape of the data

| | |
| --- | --- |
| Rows | ${dataset.length} |
| Window | ${START_DATE} → ${REFERENCE_DATE} (${months.length} calendar months: ${months.join(', ')}) |
| Accounts | ${[...accountCounts.entries()].map(([n, c]) => `${n} (${c})`).join(', ')} |
| Total spend | ${formatINR(spend)} (excludes INCOME and TRANSFER, per §5) |
| Total income | ${formatINR(income)} |

Intended category mix (what a perfect categorizer would produce — the CSV itself
carries no category column):

| Category | Rows | Share |
| --- | ---: | ---: |
${[...categoryCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([c, n]) => `| ${c} | ${n} | ${((n / dataset.length) * 100).toFixed(1)}% |`)
  .join('\n')}

## Sign convention

\`amount\` is **debit-positive**:

* **positive** — money leaving the account: purchases, fees, a card payment sent
  from checking, money sent to a friend.
* **negative** — money arriving: salary, freelance income, refunds, the credit
  card's side of a payment, money coming back from a friend.

This is what makes a refund "a negative amount" as §8 case 2 describes, and it
matches how most credit-card exports are shaped. Note the consequence: **income
rows are negative**, which is why §5 excludes \`INCOME\` and \`TRANSFER\` from spend
totals rather than relying on the sign.

## Pending vs. posted

The CSV is a flat export and has no posted-date column. In the seeded database,
transactions dated on or after **${PENDING_FROM}** have a null \`postedDate\` and are
still pending (§8 case 6); everything earlier cleared one to three days after the
transaction date.

---

# Edge case index

Row numbers are **1-based data rows**, excluding the CSV header line. Row *n* is
line *n + 1* of the file.

## 1. Transfers between the user's own accounts (§8 case 1)

A monthly credit-card payment, recorded twice — leaving checking and arriving on
the card. Both sides must be excluded from spend *and* income totals, and the two
rows must not be double-counted.

${table(pairs([...get('transfer-out'), ...get('transfer-in')]), (t) => (t.edgeCases.includes('transfer-out') ? 'out of checking' : 'onto the card'), 'Direction')}

Person-to-person round trips are also transfers — see case 9.

## 2. Refunds matched back to the originating purchase (§8 case 2)

Each pair is the same merchant and the exact same amount, ${'`'}6–13${'`'} days apart. The
refund should net against the original purchase's category in aggregates while
still being stored as \`REFUND\`.

${table(pairs([...get('refund-original'), ...get('refund')]), (t) => (t.edgeCases.includes('refund') ? 'refund' : 'original purchase'), 'Role')}

## 3. Split-worthy purchases (§8 case 3)

Single charges that really span several categories. The CSV has one row each; the
intended breakdown is listed so Phase 3 can assert against it.

${table(get('split-candidate'), (t) => (t.intendedSplits ?? []).map((s) => `${s.category} ${money(s.amount)}`).join('<br>'), 'Intended split')}

## 4. Recurring subscriptions, including a price change (§8 case 4)

${subsByMerchant.size} distinct subscriptions bill monthly. Two are special:

* **NETFLIX** rises from ${formatINR(499)} to ${formatINR(649)} partway through — a price hike Phase 6
  must flag (rows ${get('subscription-price-change')
    .map((t) => t.row)
    .join(', ')}).
* **DISNEY PLUS** only starts partway through the window — a *new* recurring
  charge, not a one-off (rows ${get('new-subscription')
    .map((t) => t.row)
    .join(', ')}).

| Subscription | Charges | Rows | Amounts |
| --- | ---: | --- | --- |
${[...subsByMerchant.entries()]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(
    ([name, rows]) =>
      `| ${name} | ${rows.length} | ${rows.map((r) => r.row).join(', ')} | ${[
        ...new Set(rows.map((r) => money(r.amount))),
      ].join(', ')} |`,
  )
  .join('\n')}

## 5. Duplicates from a sync glitch — and legitimate repeats (§8 case 5)

The hard part is telling these two groups apart. **Both** groups contain rows with
an identical merchant, amount and date.

### Sync-glitch duplicates — should be flagged

${table(pairs([...get('duplicate-original'), ...get('duplicate-glitch')]), (t) => (t.edgeCases.includes('duplicate-glitch') ? 'the glitch copy' : 'the real one'), 'Role')}

### Legitimate repeats — must NOT be flagged

Two coffees on the same day at the same price. A dedupe rule that keys only on
(merchant, amount, date) will produce a false positive on every one of these.

${table(get('legit-repeat'))}

## 6. Pending vs. posted transactions (§8 case 6)

${get('pending').length} rows dated on or after ${PENDING_FROM} are still pending — null \`postedDate\`
in the database. They should not be treated as settled.

${table(get('pending'))}

## 7. Foreign transaction fees split from the purchase (§8 case 7)

Each foreign purchase is followed by its own 3% fee line on the same date. The fee
belongs in \`FEES_INTEREST\`, not in the purchase's category, but the two need to
stay associated.

${table(pairs([...get('fx-purchase'), ...get('fx-fee')]), (t) => (t.edgeCases.includes('fx-fee') ? '3% fee' : 'foreign purchase'), 'Role')}

## 8. Ambiguous, processor-mangled merchant strings (§8 case 8)

${mangled.length} rows across ${mangledByMerchant.size} merchants carry a payment-processor prefix, a
gateway name, or a trailing store/order id that varies row to row. The
**normalizes to** column is what Phase 2's normalizer is expected to produce, and
what the LLM merchant cache is keyed on.

| Example raw descriptor | Normalizes to | Rows | First row |
| --- | --- | ---: | ---: |
${[...mangledByMerchant.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .map(
    ([normalized, info]) =>
      `| \`${cell(info.example)}\` | \`${normalized}\` | ${info.count} | ${info.firstRow} |`,
  )
  .join('\n')}

## 9. Person-to-person payments that round-trip (§8 case 9)

Money sent to a friend and paid back days later. Neither leg is real spending;
counting the outgoing leg alone overstates the month.

${table(pairs([...get('p2p-out'), ...get('p2p-in')]), (t) => (t.edgeCases.includes('p2p-out') ? 'sent' : 'paid back'), 'Direction')}

## 10. Large one-off purchases (§8 case 10)

Big enough to distort any category average they land in, but not anomalies —
anomaly detection must not simply flag "unusually large".

${table(get('large-one-off'))}

## 11. Irregular and variable income (§8 case 11)

Income arrives from three sources with different rhythms: a semi-monthly salary
that varies slightly, freelance payments that vary in both timing and size, and a
one-off bonus.

${table(get('variable-income'))}

## 12. Manual corrections that must survive re-import (§8 case 12)

These rows are seeded already corrected — \`source = MANUAL\`, with the category a
human chose — and each one has a matching \`Rule\` with
\`learnedFromOverride = true\`. Re-importing the CSV or re-running the rule and LLM
passes must leave them alone.

${table(get('manual-override'), (t) => `${t.manualCategory} (a naive parser would guess otherwise)`, 'Corrected to')}
`;
}
