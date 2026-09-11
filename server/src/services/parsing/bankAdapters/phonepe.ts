/**
 * PhonePe transaction statements — and the same shape GPay and Paytm export.
 *
 * Not a table at all, which is why no amount of column-splitting reads it. Each
 * transaction is a small block:
 *
 *     Mar 01, 2026   Paid to RAMESH KUMAR        DEBIT INR 1,250.00
 *     Transaction ID T0000000000000042           UTR 600000001554
 *     UPI ID: rameshkumar@ybl                    Paid by: XXXXXXXX4021
 *
 * The direction is a word, not a column. The counterparty is a person as often
 * as a shop — and a person's name is not a merchant, which is why it is kept
 * verbatim in `counterpartyRaw` rather than being handed to the normalizer and
 * tidied into something that looks like a brand.
 *
 * The VPA is the most identifying thing in the block: two people can be called
 * Ramesh Kumar, but `rameshkumar@ybl` is one account.
 */
import { parseStatementDate } from '../statement';
import { buildRow, findVpa, money } from './shared';
import type { BankAdapter, NormalizedRow, AdapterInput } from './types';

/** `Mar 01, 2026   Paid to SOMEONE   DEBIT INR 1,250.00` */
const HEADLINE =
  /^([A-Za-z]{3}\s+\d{1,2},\s*\d{4})\s+(Paid to|Received from|Paid By|Money sent to|Money received from)\s+(.+?)\s+(DEBIT|CREDIT)\s+(?:INR|₹)\s*([\d,]+(?:\.\d{1,2})?)$/i;

/** `Mar 01, 2026` — a comma-separated month name, which parseStatementDate does not take. */
function parseAppDate(value: string): string | null {
  const m = /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/.exec(value.trim());
  if (!m) return null;
  return parseStatementDate(`${m[2]} ${m[1]} ${m[3]}`);
}

export const phonePeAdapter: BankAdapter = {
  id: 'phonepe',
  label: 'PhonePe (UPI)',

  detectSignature(rawText) {
    const text = rawText.toLowerCase();
    const isApp = text.includes('phonepe') || text.includes('transaction statement');
    // The block shape, not just the brand: a PhonePe receipt is also "PhonePe".
    const hasBlocks = /\b(paid to|received from)\b/i.test(rawText) && /\btransaction id\b/i.test(text);
    return isApp && hasBlocks;
  },

  parse({ lines }: AdapterInput): NormalizedRow[] {
    const rows: NormalizedRow[] = [];

    lines.forEach((line, i) => {
      const match = HEADLINE.exec(line.text.replace(/\s+/g, ' ').trim());
      if (!match) return;

      const [, dateText, direction, counterparty, drcr, amountText] = match;
      const date = parseAppDate(dateText);
      const amount = money(amountText);
      if (!date || amount === null) return;

      // The two lines under the headline carry the ids. Read them rather than
      // assuming: a block near a page break can be short.
      const detail = [lines[i + 1]?.text ?? '', lines[i + 2]?.text ?? ''].join(' ');
      const upiVpa = findVpa(detail);
      const transactionId = /\bTransaction ID\s+(\S+)/i.exec(detail)?.[1] ?? null;

      const incoming = /credit/i.test(drcr) || /^received/i.test(direction);
      const name = counterparty.trim();

      rows.push(
        buildRow({
          index: rows.length + 1,
          date,
          // A UPI transfer settles immediately; there is no separate value date.
          postedDate: date,
          // The description keeps the app's own wording, so the review queue
          // shows what the person would recognise from their phone.
          description: transactionId ? `${direction} ${name} (${transactionId})` : `${direction} ${name}`,
          amount: incoming ? -Math.abs(amount) : Math.abs(amount),
          // The key comes from who was paid, not from the sentence saying so.
          merchantFrom: name,
          counterpartyRaw: name,
          upiVpa,
        }),
      );
    });

    return rows;
  },
};
