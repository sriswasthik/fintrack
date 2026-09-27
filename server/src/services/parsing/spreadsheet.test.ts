import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { detectMapping, inspectHeaders, parseTransactions } from './csv';
import { isSpreadsheet, spreadsheetToCsv, UnreadableSpreadsheetError } from './spreadsheet';

/** Excel's day number for a date: days since 1899-12-30. */
const serial = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 25569;

/**
 * An HDFC-shaped statement sheet. Every value is invented. Dates are real
 * date cells in Excel's default short-date format, which is month-first — the
 * thing that must not leak into how they are read.
 */
function statementSheet(): XLSX.WorkSheet {
  const date = (iso: string) => ({ t: 'n', v: serial(iso), z: 'm/d/yy' });
  const sheet = XLSX.utils.aoa_to_sheet([
    ['HDFC BANK Ltd.'],
    ['Account No : XXXXXXXX1234'],
    [],
    [
      'Date',
      'Narration',
      'Chq./Ref.No.',
      'Value Dt',
      'Withdrawal Amt.',
      'Deposit Amt.',
      'Closing Balance',
    ],
    [
      date('2026-03-01'),
      'UPI-SWIGGY-SWIGGY@ICICI',
      '0000606012345678',
      date('2026-03-01'),
      450,
      null,
      52550,
    ],
    [
      date('2026-05-03'),
      'NEFT CR-NORTHWIND LABS SALARY',
      'N064260012345',
      date('2026-05-03'),
      null,
      85000,
      137550,
    ],
    [
      date('2026-05-04'),
      'POS BIGBASKET',
      '0000000000001',
      date('2026-05-05'),
      1234.5,
      null,
      136315.5,
    ],
  ]);
  return sheet;
}

function workbook(sheets: Record<string, XLSX.WorkSheet>): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  for (const [name, sheet] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return book;
}

const write = (book: XLSX.WorkBook, bookType: XLSX.BookType) =>
  XLSX.write(book, { type: 'buffer', bookType }) as Buffer;

/** Reads a workbook the way the upload route does, all the way to rows. */
function rowsOf(buffer: Buffer) {
  const csv = spreadsheetToCsv(buffer);
  const mapping = detectMapping(inspectHeaders(csv).headers)!.mapping;
  return parseTransactions(csv, mapping);
}

const EXPECTED = [
  ['2026-03-01', 450],
  ['2026-05-03', -85000],
  ['2026-05-04', 1234.5],
];

describe('spreadsheetToCsv', () => {
  it.each(['xlsx', 'xls'] as const)('reads a .%s statement into rows', (bookType) => {
    const buffer = write(workbook({ Statement: statementSheet() }), bookType);
    const { rows, errors, dateOrder } = rowsOf(buffer);

    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.date, r.amount])).toEqual(EXPECTED);
    // Date cells come through as ISO, so there is no order to guess at.
    expect(dateOrder.basis).toBe('file');
    expect(rows[2].postedDate).toBe('2026-05-05');
  });

  it('reads the HTML table some banks send under an .xls name', () => {
    const html = XLSX.utils.sheet_to_html(
      XLSX.utils.aoa_to_sheet([
        ['Txn Date', 'Description', 'Debit', 'Credit', 'Balance'],
        ['01/03/2026', 'UPI/ZOMATO', '325.00', '', '10675.00'],
        ['15/03/2026', 'NEFT SALARY', '', '50000.00', '60675.00'],
      ]),
    );
    const buffer = Buffer.from(html);
    expect(isSpreadsheet(buffer, 'statement.xls')).toBe(true);

    const { rows } = rowsOf(buffer);
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-03-01', 325],
      ['2026-03-15', -50000],
    ]);
  });

  it('finds the sheet that holds the transactions', () => {
    const summary = XLSX.utils.aoa_to_sheet([['Statement summary'], ['Opening balance', 53000]]);
    const buffer = write(workbook({ Summary: summary, Transactions: statementSheet() }), 'xlsx');
    expect(rowsOf(buffer).rows).toHaveLength(3);
  });

  it('refuses a file that is not a workbook at all', () => {
    const junk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
    expect(() => spreadsheetToCsv(junk)).toThrow(UnreadableSpreadsheetError);
  });

  it('refuses an empty workbook', () => {
    const buffer = write(workbook({ Sheet1: XLSX.utils.aoa_to_sheet([]) }), 'xlsx');
    expect(() => spreadsheetToCsv(buffer)).toThrow('This spreadsheet is empty');
  });
});

describe('isSpreadsheet', () => {
  it('knows a workbook by its bytes, whatever it is called', () => {
    const book = workbook({ S: statementSheet() });
    expect(isSpreadsheet(write(book, 'xlsx'), 'download')).toBe(true);
    expect(isSpreadsheet(write(book, 'xls'), 'download')).toBe(true);
  });

  it('leaves CSV text to the CSV reader', () => {
    expect(isSpreadsheet(Buffer.from('date,description,amount\n'), 'export.csv')).toBe(false);
  });
});
