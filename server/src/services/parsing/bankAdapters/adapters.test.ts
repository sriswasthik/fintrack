import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateDataset, type GeneratedTransaction } from '../../../../prisma/seed-data';
import { extractPdfText } from '../pdf';
import { groupIntoLines, parseGenericStatement, toPlainText } from '../statement';
import { ADAPTERS, detectSource, parseWithAdapter, type AdapterInput } from './index';
import { findVpa, money } from './shared';

const FIXTURES = join(__dirname, '..', '..', '..', '..', '..', 'test-data');

async function load(name: string): Promise<AdapterInput & { pageCount: number }> {
  const pages = await extractPdfText(readFileSync(join(FIXTURES, name)));
  return {
    pages,
    lines: pages.flatMap((page) => groupIntoLines(page)),
    rawText: toPlainText(pages),
    pageCount: pages.length,
  };
}

/** Every row must match what the generator recorded when it wrote the fixture. */
function expectMatchesTruth(
  rows: { date: string; amount: number; normalizedMerchant: string }[],
  truth: GeneratedTransaction[],
) {
  expect(rows).toHaveLength(truth.length);
  rows.forEach((row, i) => {
    expect({ date: row.date, merchant: row.normalizedMerchant }).toEqual({
      date: truth[i].date,
      merchant: truth[i].normalizedMerchant,
    });
    expect(row.amount).toBeCloseTo(truth[i].amount, 2);
  });
}

const dataset = generateDataset();

describe('detectSource', () => {
  it('recognises each format from its own text', async () => {
    expect(detectSource((await load('statement_sbi.pdf')).rawText)).toBe('sbi');
    expect(detectSource((await load('statement_hdfc.pdf')).rawText)).toBe('hdfc');
    expect(detectSource((await load('statement_phonepe.pdf')).rawText)).toBe('phonepe');
  });

  it('says unknown for a bank nobody wrote an adapter for', async () => {
    // Which is not a failure: it is what sends the file to the generic reader.
    expect(detectSource((await load('statement_axis.pdf')).rawText)).toBe('unknown');
  });

  it('is not fooled by a bank merely being mentioned', () => {
    expect(detectSource('Thank you for banking with State Bank of India.')).toBe('unknown');
    expect(detectSource('Your HDFC Bank credit card is due on the 5th.')).toBe('unknown');
    expect(detectSource('')).toBe('unknown');
  });

  it('does not let a bank statement quoting a UPI id look like a UPI export', () => {
    // An SBI narration routinely contains "UPI/DR/.../swiggy@ybl".
    const sbiish = [
      'STATE BANK OF INDIA',
      'Account Statement from 01 Mar 2026 to 30 Apr 2026',
      'Txn Date Value Date Description Ref No./Cheque No. Debit Balance',
      '01 Mar 2026 02 Mar 2026 TO TRANSFER-UPI/DR/604812345678/SWIGGY/HDFC/swiggy@ybl TRF000000001 228.21 2,17,771.79',
    ].join('\n');
    expect(detectSource(sbiish)).toBe('sbi');
  });
});

describe('the SBI adapter', () => {
  it('reads every row correctly', async () => {
    const result = parseWithAdapter(await load('statement_sbi.pdf'));
    expect(result?.source).toBe('sbi');
    expectMatchesTruth(result!.rows, dataset.slice(0, 45));
  });

  it('reads a credit marked "(Cr)" as money arriving, not leaving', async () => {
    // SBI has one amount column and marks credits rather than columning them.
    // Read as a debit, the month's income comes out with the wrong sign.
    const result = parseWithAdapter(await load('statement_sbi.pdf'));
    const credits = result!.rows.filter((r) => r.amount < 0);
    expect(credits.length).toBeGreaterThan(0);
    expect(credits[0].normalizedMerchant).toBe('RAZORPAY');
  });

  it('keeps both dates: the transaction date and the value date', async () => {
    const result = parseWithAdapter(await load('statement_sbi.pdf'));
    const withLag = result!.rows.filter((r) => r.postedDate && r.postedDate !== r.date);
    expect(withLag.length).toBeGreaterThan(0);
  });
});

describe('the HDFC adapter', () => {
  it('reads every row correctly', async () => {
    const result = parseWithAdapter(await load('statement_hdfc.pdf'));
    expect(result?.source).toBe('hdfc');
    expectMatchesTruth(
      result!.rows,
      dataset.filter((t) => t.date.startsWith('2026-03')),
    );
  });

  it('tells a withdrawal from a deposit by which column it is printed in', async () => {
    const result = parseWithAdapter(await load('statement_hdfc.pdf'));
    expect(result!.rows.some((r) => r.amount > 0)).toBe(true);
    expect(result!.rows.some((r) => r.amount < 0)).toBe(true);
  });

  it('reads the two-digit year as this century', async () => {
    const result = parseWithAdapter(await load('statement_hdfc.pdf'));
    expect(result!.rows.every((r) => r.date.startsWith('2026-'))).toBe(true);
  });
});

describe('the PhonePe adapter', () => {
  it('reads every row correctly', async () => {
    const result = parseWithAdapter(await load('statement_phonepe.pdf'));
    expect(result?.source).toBe('phonepe');
    expectMatchesTruth(result!.rows, dataset.slice(0, 30));
  });

  it('captures the counterparty and the VPA', async () => {
    const result = parseWithAdapter(await load('statement_phonepe.pdf'));
    expect(result!.rows.every((r) => r.counterpartyRaw)).toBe(true);
    expect(result!.rows.every((r) => r.upiVpa?.includes('@'))).toBe(true);
  });

  it('derives the merchant key from who was paid, not from the app’s wording', async () => {
    // "Paid to PRESTIGE PROPERTY MGMT" must reduce to the same key the same
    // merchant gets from a bank statement, or nothing matches across sources.
    const [upi, bank] = await Promise.all([
      load('statement_phonepe.pdf'),
      load('statement_hdfc.pdf'),
    ]);
    const upiRow = parseWithAdapter(upi)!.rows[0];
    const bankRow = parseWithAdapter(bank)!.rows[0];

    expect(upiRow.normalizedMerchant).toBe(bankRow.normalizedMerchant);
    expect(upiRow.normalizedMerchant).not.toMatch(/paid to/i);
    // The app's own wording still survives, where a person would recognise it.
    expect(upiRow.description).toMatch(/^Paid to /);
  });

  it('reads "Received from" as money arriving', async () => {
    const result = parseWithAdapter(await load('statement_phonepe.pdf'));
    expect(result!.rows.some((r) => r.amount < 0)).toBe(true);
  });
});

describe('a format no adapter claims', () => {
  it('falls through to the Phase 12 generic reader, intact', async () => {
    const input = await load('statement_axis.pdf');
    expect(parseWithAdapter(input)).toBeNull();

    const generic = parseGenericStatement(input.pages);
    expect(generic).not.toBeNull();
    expectMatchesTruth(generic!.rows, dataset.slice(0, 40));
  });
});

describe('every adapter', () => {
  it('declines text that is not its format', async () => {
    const letter = 'Dear customer, thank you for banking with us.';
    for (const adapter of ADAPTERS) {
      expect(adapter.detectSignature(letter)).toBe(false);
    }
  });

  it('produces debit-positive amounts, like every other source', async () => {
    for (const name of ['statement_sbi.pdf', 'statement_hdfc.pdf', 'statement_phonepe.pdf']) {
      const rows = parseWithAdapter(await load(name))!.rows;
      // Rent is money leaving, so it is positive whichever format printed it.
      const rent = rows.find((r) => r.normalizedMerchant === 'PRESTIGE PROPERTY MGMT');
      expect(rent?.amount).toBeGreaterThan(0);
    }
  });
});

describe('money', () => {
  it('reads the Indian grouping a bank prints', () => {
    expect(money('1,23,456.78')).toBe(123456.78);
    expect(money('32,000.00')).toBe(32000);
  });

  it('reads a credit marker without letting it break the number', () => {
    // Stripping the parens first welds "Cr" onto the digits; order matters.
    expect(money('9,371.92 (Cr)')).toBe(9371.92);
    expect(money('9,371.92 Cr')).toBe(9371.92);
  });

  it('reads a parenthesised negative', () => {
    expect(money('(1,234.00)')).toBe(-1234);
  });

  it('returns null for a blank cell', () => {
    expect(money('')).toBeNull();
    expect(money('-')).toBeNull();
    expect(money(undefined)).toBeNull();
    expect(money('not a number')).toBeNull();
  });
});

describe('findVpa', () => {
  it('finds a VPA in a line of detail', () => {
    expect(findVpa('UPI ID: rameshkumar@ybl  Paid by: XXXX4021')).toBe('rameshkumar@ybl');
    expect(findVpa('merchant@okaxis')).toBe('merchant@okaxis');
  });

  it('is not fooled by an email address', () => {
    // A statement footer carries a support address; it is not a payment address.
    expect(findVpa('Questions? write to care@phonepe.com')).toBeNull();
    expect(findVpa('someone@example.in')).toBeNull();
  });

  it('returns null when there is none', () => {
    expect(findVpa('Transaction ID T0000000000000001')).toBeNull();
  });
});
