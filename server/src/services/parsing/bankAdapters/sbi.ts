/**
 * State Bank of India account statements.
 *
 * Two things make this its own adapter rather than a generic table:
 *
 *   * **Two date columns.** "Txn Date" is when it happened, "Value Date" when
 *     it cleared. The generic reader takes the first column carrying a date as
 *     *the* date column and has no idea the second one is also a date — so it
 *     either loses the posted date or, worse, reads the value date as the
 *     narration. Here the two are read as what they are.
 *   * **One amount column.** SBI prints credits in the debit column with a
 *     `(Cr)` marker rather than giving them a column of their own. A reader
 *     expecting separate debit and credit columns sees every credit as a debit
 *     and gets the sign of the month's income exactly backwards.
 */
import { parseStatementDate } from '../statement';
import { buildRow, money } from './shared';
import type { BankAdapter, NormalizedRow } from './types';

/** `01 Mar 2026`, which is how SBI prints both of its dates. */
const SBI_DATE = /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/;

/** A credit, which SBI marks rather than columning. */
const CREDIT_MARKER = /\(\s*cr\s*\)/i;

export const sbiAdapter: BankAdapter = {
  id: 'sbi',
  label: 'State Bank of India',

  detectSignature(rawText) {
    const text = rawText.toLowerCase();
    // The bank's own name plus a word that only appears on a statement: the
    // name alone would claim any letter SBI ever sent.
    const isSbi = text.includes('state bank of india') || /\bsbin0\d{6}\b/i.test(rawText);
    return isSbi && (text.includes('account statement') || text.includes('txn date'));
  },

  parse({ lines }): NormalizedRow[] {
    const rows: NormalizedRow[] = [];

    for (const line of lines) {
      const items = line.items;
      // A transaction row starts with a transaction date and a value date.
      if (items.length < 5) continue;
      const txnDate = parseStatementDate(items[0].text);
      const valueDate = SBI_DATE.test(items[1].text) ? parseStatementDate(items[1].text) : null;
      if (!txnDate || !valueDate) continue;

      // Last is the running balance, second to last the amount; everything
      // between the value date and those two is narration and reference.
      const balanceIndex = items.length - 1;
      const amountIndex = items.length - 2;
      const amountText = items[amountIndex].text;
      const amount = money(amountText);
      if (amount === null || money(items[balanceIndex].text) === null) continue;

      const middle = items.slice(2, amountIndex).map((i) => i.text);
      if (middle.length === 0) continue;

      // The reference is the last of the middle cells when it looks like one.
      const looksLikeReference = /^[A-Z]{2,4}\d{4,}$/.test(middle[middle.length - 1] ?? '');
      const narration = (looksLikeReference ? middle.slice(0, -1) : middle).join(' ').trim();
      if (!narration) continue;

      const isCredit = CREDIT_MARKER.test(amountText);
      rows.push(
        buildRow({
          index: rows.length + 1,
          date: txnDate,
          postedDate: valueDate,
          description: narration,
          // Debit-positive: a credit is money arriving, so it is negative.
          amount: isCredit ? -Math.abs(amount) : Math.abs(amount),
          counterpartyRaw: narration,
        }),
      );
    }

    return rows;
  },
};
