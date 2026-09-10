/**
 * Generates the two PDF statement fixtures in `test-data/`.
 *
 * `npm run test-data:pdf --workspace server`
 *
 * Both are the same statement — a slice of the Phase 1 synthetic dataset, laid
 * out as a generic tabular bank statement — so a test can assert that the
 * encrypted one produces exactly the rows the plain one does. Only the
 * encryption differs, which is the variable under test.
 *
 * The layout is deliberately plain: fixed column x-positions, one row per
 * transaction. That is what the reference column-splitter is written against,
 * and a fixture that quietly matched some cleverer heuristic would not be
 * testing the thing that ships.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import PDFDocument from 'pdfkit';

import { generateDataset, type GeneratedTransaction } from '../prisma/seed-data';

/** Known, committed, and useless anywhere else — this opens a fixture. */
export const FIXTURE_PASSWORD = 'fintrack-test-password';

const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'test-data');

/** How many rows go in the fixture. Enough to span pages, small enough to read. */
const ROW_COUNT = 60;

/**
 * Fixed positions, all inside A4's 595pt width. Columns that run off the page
 * get silently clipped by pdfkit, which produced a fixture whose "Balance"
 * header read "Balan" — a fixture bug that would have looked like a parser bug.
 */
const COLUMNS = [
  { header: 'Date', x: 40, width: 56, align: 'left' as const },
  { header: 'Narration', x: 100, width: 174, align: 'left' as const },
  { header: 'Reference No', x: 278, width: 68, align: 'left' as const },
  { header: 'Debit', x: 350, width: 60, align: 'right' as const },
  { header: 'Credit', x: 414, width: 60, align: 'right' as const },
  { header: 'Balance', x: 478, width: 77, align: 'right' as const },
];

/** The rule under the header, and the page's right edge for it. */
const TABLE_RIGHT = 555;

const inr = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** dd/mm/yyyy — how an Indian bank prints a statement date. */
const statementDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/** A stable pseudo-reference, so the fixture is byte-identical between runs. */
const reference = (t: GeneratedTransaction) => `S${String(t.row).padStart(6, '0')}`;

function buildStatement(rows: GeneratedTransaction[], password?: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    ...(password ? { userPassword: password, ownerPassword: password } : {}),
    info: { Title: 'FinTrack synthetic statement', Author: 'FinTrack test data' },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let balance = 250000;

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(14).text('SYNTHETIC BANK — STATEMENT OF ACCOUNT', 40, 40);
    doc.font('Helvetica').fontSize(9);
    doc.text('Account: XXXXXXXX4021    Everyday Checking    Currency: INR', 40, 60);
    doc.font('Helvetica-Bold').fontSize(9);
    COLUMNS.forEach((c) => doc.text(c.header, c.x, 86, { width: c.width, align: c.align }));
    doc.moveTo(40, 100).lineTo(TABLE_RIGHT, 100).stroke();
    doc.font('Helvetica').fontSize(8);
  };

  header();
  let y = 108;

  for (const t of rows) {
    if (y > 780) {
      doc.addPage();
      header();
      y = 108;
    }

    // Debit-positive in the dataset; a statement prints the two in separate
    // columns and never both on one line.
    const debit = t.amount > 0 ? inr(t.amount) : '';
    const credit = t.amount < 0 ? inr(-t.amount) : '';
    balance -= t.amount;

    const cells = [
      statementDate(t.date),
      t.description,
      reference(t),
      debit,
      credit,
      inr(balance),
    ];
    COLUMNS.forEach((c, i) =>
      doc.text(cells[i], c.x, y, { width: c.width, align: c.align, lineBreak: false }),
    );
    y += 13;
  }

  doc.end();
  return done;
}

async function main() {
  // A contiguous slice, so the fixture reads like one month of a real account.
  const rows = generateDataset().slice(0, ROW_COUNT);

  const plain = await buildStatement(rows);
  writeFileSync(join(OUT, 'statement_plain.pdf'), plain);
  console.log(`Wrote test-data/statement_plain.pdf (${rows.length} rows, ${plain.length} bytes)`);

  const encrypted = await buildStatement(rows, FIXTURE_PASSWORD);
  writeFileSync(join(OUT, 'statement_encrypted.pdf'), encrypted);
  console.log(
    `Wrote test-data/statement_encrypted.pdf (same rows, password "${FIXTURE_PASSWORD}", ${encrypted.length} bytes)`,
  );
}

void main();
