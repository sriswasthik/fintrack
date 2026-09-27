/**
 * What of a statement the fallback reader is allowed to see.
 *
 * The model is asked to transcribe transaction rows, and a row is all it
 * needs. The rest of a statement is the most identifying text a person owns:
 * their name and address, the account number, IFSC and customer ID, the PAN
 * some banks print on the first page. None of that helps read a row, so none of
 * it is sent.
 *
 * Two steps, both deliberately blunt:
 *
 *   1. **Keep the table.** Column-title lines, and everything from the first
 *      transaction row to the last. The preamble above the table and the
 *      footer below it are dropped. Inside the table, a line that labels
 *      account details — a statement repeats its header on every page — is
 *      dropped too, unless it is itself a transaction row.
 *   2. **Mask identifiers in what is kept.** PAN, Aadhaar-shaped numbers, email
 *      addresses, and any long run of digits — an account number, a phone
 *      number, a UPI reference — down to its last four. A transcription does
 *      not need them, and the merchant normalizer strips them anyway.
 *
 * What still goes: dates, amounts, and the narration of each row, including
 * the name of whoever a payment went to. That is the transaction itself, and
 * it is what the reader exists to read.
 */

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

/** A date anywhere in a line, in any of the shapes a statement prints. */
const DATE_TOKEN = new RegExp(
  [
    String.raw`\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b`,
    String.raw`\b\d{4}-\d{1,2}-\d{1,2}\b`,
    String.raw`\b\d{1,2}[\s-]${MONTH}[\s,-]+(?:\d{4}|\d{2})\b`,
    String.raw`\b${MONTH}\s+\d{1,2},?\s+\d{4}\b`,
  ].join('|'),
  'i',
);

/** A figure with paise: `1,23,456.78`, `450.00`. */
const MONEY_TOKEN = /\d[\d,]*\.\d{2}\b/;

/** A line that names the table's columns. */
function isColumnHeader(line: string): boolean {
  return (
    /\b(?:date|dt)\b/i.test(line) &&
    /\b(?:debit|credit|withdrawals?|deposits?|amount|balance|dr|cr)\b/i.test(line) &&
    !MONEY_TOKEN.test(line)
  );
}

/** Labels that introduce the account holder's details rather than a transaction. */
const ACCOUNT_DETAIL =
  /\b(?:a\/?c\.?\s*(?:no|number)|account\s*(?:no|number|holder|name|type|status)|customer\s*(?:id|name|no)|name|cust\.?\s*id|cif|ifsc|micr|branch|address|e-?mail|phone|mobile|pan|ckyc|nominee|joint\s*holder)\b/i;

const MASKS: [RegExp, (match: string) => string][] = [
  // Email before anything else, so its digits are not half-masked first.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, () => '[email]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => '[PAN]'],
  [/\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, () => '[ID]'],
  // Nine digits or more, not part of an amount: an account number, a phone
  // number, a reference. The last four stay, which is how banks mask them too.
  [/(?<![\d,.])\d{9,18}(?![\d,]|\.\d)/g, (m) => 'X'.repeat(m.length - 4) + m.slice(-4)],
];

export interface RedactedStatement {
  text: string;
  /** Lines of the statement that were not sent at all. */
  droppedLines: number;
  /** Identifiers masked in the lines that were. */
  masked: number;
}

/**
 * The part of a statement's text the fallback reader may see.
 *
 * Returns an empty `text` when no transaction row can be found, in which case
 * there is nothing the model could usefully be sent.
 */
export function redactStatementText(fullText: string): RedactedStatement {
  const lines = fullText.split('\n');
  const isRow = (line: string) => DATE_TOKEN.test(line) && MONEY_TOKEN.test(line);

  // A row normally carries its date and its amount on one line. A layout that
  // splits them is exactly what reaches this fallback, so if no line has both,
  // the table is taken to be the span of lines with a date.
  let rowIndexes = lines.flatMap((line, i) => (isRow(line) ? [i] : []));
  if (rowIndexes.length === 0) {
    rowIndexes = lines.flatMap((line, i) => (DATE_TOKEN.test(line) ? [i] : []));
  }
  if (rowIndexes.length === 0) {
    return { text: '', droppedLines: lines.filter((l) => l.trim()).length, masked: 0 };
  }
  const rowSet = new Set(rowIndexes);
  const first = rowIndexes[0];
  const last = rowIndexes[rowIndexes.length - 1];

  let dropped = 0;
  let masked = 0;
  const kept: string[] = [];

  lines.forEach((line, i) => {
    if (!line.trim()) {
      // Page breaks inside the table keep their blank line; nothing else does.
      if (i > first && i < last) kept.push(line);
      return;
    }
    const inTable = i >= first && i <= last;
    // A transaction row always goes. Anything else goes only if it is not an
    // account detail, and is either inside the table or names its columns.
    const keep = rowSet.has(i) || (!ACCOUNT_DETAIL.test(line) && (inTable || isColumnHeader(line)));
    if (!keep) {
      dropped += 1;
      return;
    }
    let out = line;
    for (const [pattern, replace] of MASKS) {
      out = out.replace(pattern, (match) => {
        masked += 1;
        return replace(match);
      });
    }
    kept.push(out);
  });

  return { text: kept.join('\n').trim(), droppedLines: dropped, masked };
}
