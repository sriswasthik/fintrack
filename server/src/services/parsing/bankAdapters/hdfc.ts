/**
 * HDFC Bank account statements.
 *
 * The wrinkle is where the value date sits: between the reference number and
 * the amounts, rather than beside the transaction date. A generic reader
 * matching columns by position gets every amount one column out from that point
 * rightwards — which is the kind of failure that produces a plausible-looking
 * import with every figure wrong.
 *
 * Dates are `dd/mm/yy`. A two-digit year is ambiguous in principle and not in
 * practice: a bank statement is not from 1926.
 */
import { parseStatementDate } from '../statement';
import { buildRow, money } from './shared';
import type { BankAdapter, NormalizedRow } from './types';

/** `01/03/26` — HDFC's two-digit year. */
const HDFC_DATE = /^\d{2}\/\d{2}\/\d{2}$/;

export const hdfcAdapter: BankAdapter = {
  id: 'hdfc',
  label: 'HDFC Bank',

  detectSignature(rawText) {
    const text = rawText.toLowerCase();
    const isHdfc = text.includes('hdfc bank') || /\bhdfc0\d{6}\b/i.test(rawText);
    // "Chq./Ref.No." next to a value date is the layout, not just the bank.
    return isHdfc && (text.includes('narration') || text.includes('withdrawal amt'));
  },

  parse({ lines }): NormalizedRow[] {
    // Which money column a figure landed in is what says whether it was taken
    // or paid in, and the only reliable statement of where those columns are is
    // the header the file prints above them. Both columns are right-aligned, so
    // it is the right edges that line up, not the left.
    const header = lines.find(
      (line) =>
        line.items.some((i) => /withdrawal/i.test(i.text)) &&
        line.items.some((i) => /deposit/i.test(i.text)),
    );
    if (!header) return [];

    const rightEdge = (pattern: RegExp) => {
      const item = header.items.find((i) => pattern.test(i.text));
      return item ? item.x + item.width : null;
    };
    const withdrawalEdge = rightEdge(/withdrawal/i);
    const depositEdge = rightEdge(/deposit/i);
    if (withdrawalEdge === null || depositEdge === null) return [];

    /** Past this, a figure is in the deposit column rather than the withdrawal one. */
    const depositThreshold = (withdrawalEdge + depositEdge) / 2;

    const rows: NormalizedRow[] = [];

    for (const line of lines) {
      const items = line.items;
      if (items.length < 5) continue;

      const date = HDFC_DATE.test(items[0].text) ? parseStatementDate(items[0].text) : null;
      if (!date) continue;

      // Find the value date, which separates the narration side from the money
      // side. It is the second date on the row.
      const valueIndex = items.findIndex((item, i) => i > 0 && HDFC_DATE.test(item.text));
      if (valueIndex < 0) continue;
      const valueDate = parseStatementDate(items[valueIndex].text);

      const amounts = items.slice(valueIndex + 1);
      // Withdrawal, deposit, closing balance — one of the first two is blank,
      // so a row carries either two cells or three.
      if (amounts.length < 2) continue;

      const balance = money(amounts[amounts.length - 1].text);
      if (balance === null) continue;

      const present = amounts
        .slice(0, -1)
        .map((a) => ({ right: a.x + a.width, value: money(a.text) }))
        .filter((c): c is { right: number; value: number } => c.value !== null);
      // Exactly one of withdrawal and deposit carries a figure on any real row.
      if (present.length !== 1) continue;

      const [cell] = present;
      const isDeposit = cell.right > depositThreshold;

      const middle = items.slice(1, valueIndex).map((i) => i.text);
      const looksLikeReference = /^[A-Z]{2,4}\d{4,}$/.test(middle[middle.length - 1] ?? '');
      const narration = (looksLikeReference ? middle.slice(0, -1) : middle).join(' ').trim();
      if (!narration) continue;

      rows.push(
        buildRow({
          index: rows.length + 1,
          date,
          postedDate: valueDate,
          description: narration,
          amount: isDeposit ? -Math.abs(cell.value) : Math.abs(cell.value),
          counterpartyRaw: narration,
        }),
      );
    }

    return rows;
  },
};
