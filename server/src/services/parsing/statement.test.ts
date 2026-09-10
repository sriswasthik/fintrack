import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateDataset } from '../../../prisma/seed-data';
import { extractPdfText, type PdfPage, type PdfTextItem } from './pdf';
import {
  detectDateOrder,
  findColumnBands,
  findHeaderLine,
  groupIntoLines,
  parseGenericStatement,
  parseStatementDate,
  toPlainText,
} from './statement';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test-data');
const plainPdf = () => readFileSync(join(FIXTURES, 'statement_plain.pdf'));

/** A page built by hand, so the geometry under test is the geometry written. */
function page(rows: [string, number, number][]): PdfPage {
  const items: PdfTextItem[] = rows.map(([text, x, y]) => ({
    text,
    x,
    y,
    width: text.length * 5,
    height: 8,
  }));
  return { pageNumber: 1, width: 595, height: 842, items };
}

describe('groupIntoLines', () => {
  it('puts items drawn at the same height on one line, left to right', () => {
    const lines = groupIntoLines(
      page([
        ['second', 100, 700],
        ['first', 40, 700],
        ['below', 40, 680],
      ]),
    );

    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('first second');
    expect(lines[1].text).toBe('below');
  });

  it('tolerates the sub-point drift a renderer leaves between runs', () => {
    const lines = groupIntoLines(
      page([
        ['a', 40, 700],
        ['b', 60, 700.8],
      ]),
    );
    expect(lines).toHaveLength(1);
  });

  it('reads the page top-down, which is descending y', () => {
    const lines = groupIntoLines(
      page([
        ['bottom', 40, 100],
        ['top', 40, 800],
        ['middle', 40, 400],
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual(['top', 'middle', 'bottom']);
  });
});

describe('findColumnBands', () => {
  it('finds one band per column from the whitespace between them', () => {
    const lines = groupIntoLines(
      page([
        ['01/03/2026', 40, 700],
        ['SWIGGY', 100, 700],
        ['1,250.00', 380, 700],
        ['02/03/2026', 40, 688],
        ['OLA', 100, 688],
        ['289.00', 386, 688],
      ]),
    );

    const bands = findColumnBands(lines);
    expect(bands).toHaveLength(3);
    expect(bands[0].from).toBe(40);
  });

  it('merges runs that sit side by side inside one column', () => {
    // "Reference No" arrives as two runs a couple of points apart.
    const lines = groupIntoLines(
      page([
        ['Reference', 278, 700],
        ['No', 320, 700],
      ]),
    );
    expect(findColumnBands(lines)).toHaveLength(1);
  });
});

describe('findHeaderLine', () => {
  it('finds the row that names the columns', () => {
    const lines = groupIntoLines(
      page([
        ['STATEMENT OF ACCOUNT', 40, 780],
        ['Date', 40, 700],
        ['Narration', 100, 700],
        ['Debit', 380, 700],
        ['Credit', 440, 700],
      ]),
    );
    expect(findHeaderLine(lines)?.y).toBe(700);
  });

  it('is not fooled by a heading that merely says "Date"', () => {
    const lines = groupIntoLines(
      page([
        ['Date', 40, 700],
        ['of issue', 100, 700],
      ]),
    );
    expect(findHeaderLine(lines)).toBeNull();
  });

  it('accepts the words other banks use for the same columns', () => {
    const lines = groupIntoLines(
      page([
        ['Txn Date', 40, 700],
        ['Particulars', 100, 700],
        ['Withdrawal', 380, 700],
        ['Deposit', 440, 700],
      ]),
    );
    expect(findHeaderLine(lines)).not.toBeNull();
  });
});

describe('parseStatementDate', () => {
  it('reads dd/mm/yyyy, which is what a statement means by it', () => {
    expect(parseStatementDate('03/05/2026')).toBe('2026-05-03');
    expect(parseStatementDate('15/03/2026')).toBe('2026-03-15');
  });

  it('reads mm/dd/yyyy when told the file is written that way', () => {
    expect(parseStatementDate('03/05/2026', 'mdy')).toBe('2026-03-05');
  });

  it('reads the spelled-out month Indian statements often print', () => {
    expect(parseStatementDate('15-Mar-2026')).toBe('2026-03-15');
    expect(parseStatementDate('15 Mar 2026')).toBe('2026-03-15');
  });

  it('reads ISO, and refuses a date that does not exist', () => {
    expect(parseStatementDate('2026-03-15')).toBe('2026-03-15');
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementDate('nonsense')).toBeNull();
  });
});

describe('detectDateOrder', () => {
  it('settles the convention from the file rather than guessing per row', () => {
    // A day above 12 can only be a day.
    expect(detectDateOrder(['01/03/2026', '15/03/2026'])).toBe('dmy');
    expect(detectDateOrder(['03/01/2026', '03/15/2026'])).toBe('mdy');
  });

  it('falls back to dd/mm when nothing in the file settles it', () => {
    expect(detectDateOrder(['01/02/2026', '03/04/2026'])).toBe('dmy');
  });
});

describe('parseGenericStatement, against the real fixture', () => {
  it('reads every row, and reads them correctly', async () => {
    const pages = await extractPdfText(plainPdf());
    const result = parseGenericStatement(pages);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1);
    expect(result!.errors).toEqual([]);

    // Scored against what the generator recorded when it wrote the fixture —
    // the same ground truth the accuracy report uses.
    const truth = generateDataset().slice(0, result!.rows.length);
    expect(result!.rows).toHaveLength(truth.length);

    result!.rows.forEach((row, i) => {
      expect(row.date).toBe(truth[i].date);
      expect(row.amount).toBeCloseTo(truth[i].amount, 2);
      expect(row.normalizedMerchant).toBe(truth[i].normalizedMerchant);
    });
  });

  it('produces debit-positive amounts, like every other source', async () => {
    const pages = await extractPdfText(plainPdf());
    const rows = parseGenericStatement(pages)!.rows;

    // The fixture's salary credits are the negative ones.
    expect(rows.some((r) => r.amount > 0)).toBe(true);
    expect(rows.filter((r) => r.amount < 0).every((r) => r.normalizedMerchant.length > 0)).toBe(
      true,
    );
  });

  it('declines rather than guessing when the layout is not this one', () => {
    const notAStatement = [
      page([
        ['Dear customer,', 40, 700],
        ['Thank you for banking with us.', 40, 680],
      ]),
    ];
    expect(parseGenericStatement(notAStatement)).toBeNull();
  });

  it('declines when the header is there but the rows are not', () => {
    const empty = [
      page([
        ['Date', 40, 700],
        ['Narration', 100, 700],
        ['Debit', 380, 700],
        ['Credit', 440, 700],
      ]),
    ];
    expect(parseGenericStatement(empty)).toBeNull();
  });
});

describe('toPlainText', () => {
  it('flattens the pages for the fallback reader, one line per line', async () => {
    const text = toPlainText(await extractPdfText(plainPdf()));
    expect(text).toContain('Narration');
    expect(text.split('\n').length).toBeGreaterThan(50);
  });
});
