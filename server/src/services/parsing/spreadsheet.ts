/**
 * Excel statements, read as the CSV they would have been.
 *
 * Most Indian banks offer a statement as XLS or XLSX before they offer CSV, and
 * the table inside is the same one: account details above it, separate debit
 * and credit columns, day-first dates. So a workbook is turned into CSV text
 * here and everything after that — finding the header, recognising the
 * columns, settling the date order — is the CSV path, unchanged.
 *
 * Read with SheetJS, which also takes the legacy `.xls` format and the HTML
 * tables some banks send under an `.xls` name.
 */
import * as XLSX from 'xlsx';

import { headerLineIndex } from './csv';

/** A workbook that could not be read at all. */
export class UnreadableSpreadsheetError extends Error {
  constructor(message = 'This file could not be read as a spreadsheet') {
    super(message);
    this.name = 'UnreadableSpreadsheetError';
  }
}

/**
 * The most rows read from a sheet. Matches what one commit accepts, and keeps
 * a hostile workbook from being expanded without limit.
 */
const MAX_SHEET_ROWS = 20_000;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Is this upload a workbook rather than CSV text?
 *
 * Decided by the bytes where they are conclusive — an XLSX is a zip, an XLS is
 * an OLE compound file — and by the name otherwise, which is what catches the
 * HTML table a bank names `.xls`.
 */
export function isSpreadsheet(buffer: Buffer, fileName = ''): boolean {
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC)) return true;
  if (buffer.subarray(0, 8).equals(OLE_MAGIC)) return true;
  return /\.xlsx?$/i.test(fileName);
}

function isoDate(serial: number): string | null {
  const parts = XLSX.SSF.parse_date_code(serial) as { y: number; m: number; d: number } | null;
  if (!parts || !parts.y) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

/**
 * Rewrites what each cell will print as.
 *
 * A date cell prints however its number format says — and Excel's default
 * short-date format is month-first, which would make every day-first
 * statement's dates ambiguous or wrong. Written as ISO, a date means one thing.
 * A number prints as its plain value rather than through a display format that
 * might round it or add a currency symbol.
 */
function normalizeCells(sheet: XLSX.WorkSheet): void {
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!')) continue;
    const c = cell as XLSX.CellObject;
    if (c.t !== 'n' || typeof c.v !== 'number') continue;
    const format = typeof c.z === 'string' ? c.z : '';
    const date = format && XLSX.SSF.is_date(format) ? isoDate(c.v) : null;
    c.w = date ?? String(c.v);
  }
}

/**
 * The workbook as CSV text: the sheet holding the transaction table, or the
 * first sheet with anything in it when no sheet looks like one.
 */
export function spreadsheetToCsv(buffer: Buffer): string {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellNF: true, sheetRows: MAX_SHEET_ROWS });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // "File is password-protected", "Encryption scheme unsupported" — but not
    // "Unsupported ZIP encryption", which is what a damaged file produces.
    if (/password|^encryption/i.test(message)) {
      throw new UnreadableSpreadsheetError(
        'This spreadsheet is password-protected. Open it, save a copy without the password, and upload that.',
      );
    }
    throw new UnreadableSpreadsheetError();
  }

  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    normalizeCells(sheet);
    return XLSX.utils.sheet_to_csv(sheet, { blankrows: false, strip: true });
  }).filter((csv) => csv.trim());

  if (sheets.length === 0) throw new UnreadableSpreadsheetError('This spreadsheet is empty');
  return sheets.find((csv) => headerLineIndex(csv) >= 0) ?? sheets[0];
}
