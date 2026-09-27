/**
 * Generates the Phase 13 statement fixtures in `test-data/`.
 *
 * `npm run test-data:banks --workspace server`
 *
 * Four layouts, all built from the same Phase 1 dataset so any two can be
 * compared row for row:
 *
 *   sbi       two date columns, which is the thing the generic reader gets
 *             wrong and the reason SBI needs an adapter at all
 *   hdfc      a value date wedged between the reference and the amounts,
 *             dd/mm/yy, and "Withdrawal Amt." rather than "Debit"
 *   phonepe   not a table: blocks of "Paid to <name>", a transaction id,
 *             a UTR and a VPA
 *   axis      a fourth bank no adapter claims, to prove a file still reads
 *             through the Phase 12 generic parser
 *
 * Plus three consecutive HDFC months for the quarterly batch, where May
 * deliberately repeats the last days of April — which is what a real bank does,
 * and what cross-file duplicate detection exists for.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import PDFDocument from 'pdfkit';

import { generateDataset, type GeneratedTransaction } from '../prisma/seed-data';

const OUT = join(__dirname, '..', '..', 'test-data');

const inr = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pad = (n: number) => String(n).padStart(2, '0');
const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];

const ddmmyyyy = (iso: string) => {
  const [y, m, d] = parts(iso);
  return `${pad(d)}/${pad(m)}/${y}`;
};
const ddmmyy = (iso: string) => {
  const [y, m, d] = parts(iso);
  return `${pad(d)}/${pad(m)}/${String(y).slice(2)}`;
};
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const ddMon = (iso: string) => {
  const [y, m, d] = parts(iso);
  return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
};
const monDComma = (iso: string) => {
  const [y, m, d] = parts(iso);
  return `${MONTHS[m - 1]} ${pad(d)}, ${y}`;
};

/** A stable pseudo-reference, so a fixture is identical between runs. */
const ref = (t: GeneratedTransaction, prefix = 'S') => `${prefix}${String(t.row).padStart(9, '0')}`;

/** A VPA for a counterparty, in the shape a UPI app prints. */
function vpa(merchant: string): string {
  const handle = merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 14);
  const banks = ['ybl', 'okaxis', 'paytm', 'oksbi', 'ibl'];
  // Deterministic: the same merchant always gets the same handle.
  const bank = banks[merchant.length % banks.length];
  return `${handle}@${bank}`;
}

interface Column {
  header: string;
  x: number;
  width: number;
  align: 'left' | 'right';
}

interface TableLayout {
  title: string;
  preamble: string[];
  columns: Column[];
  right: number;
  /** The cells for one transaction, in column order. */
  cells: (t: GeneratedTransaction, balance: number) => string[];
}

function buildTable(layout: TableLayout, rows: GeneratedTransaction[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: layout.title } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );

  let balance = 250000;

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(13).text(layout.title, 40, 40);
    doc.font('Helvetica').fontSize(8.5);
    layout.preamble.forEach((line, i) => doc.text(line, 40, 58 + i * 12));
    const top = 58 + layout.preamble.length * 12 + 12;
    doc.font('Helvetica-Bold').fontSize(8);
    layout.columns.forEach((c) =>
      doc.text(c.header, c.x, top, { width: c.width, align: c.align, lineBreak: false }),
    );
    doc
      .moveTo(40, top + 14)
      .lineTo(layout.right, top + 14)
      .stroke();
    doc.font('Helvetica').fontSize(7.5);
    return top + 22;
  };

  let y = header();

  for (const t of rows) {
    if (y > 790) {
      doc.addPage();
      y = header();
    }
    balance -= t.amount;
    const cells = layout.cells(t, balance);
    layout.columns.forEach((c, i) =>
      doc.text(cells[i], c.x, y, { width: c.width, align: c.align, lineBreak: false }),
    );
    y += 12;
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// SBI — two date columns
// ---------------------------------------------------------------------------

const SBI: TableLayout = {
  title: 'STATE BANK OF INDIA',
  preamble: [
    'Account Statement from 01 Mar 2026 to 30 Apr 2026',
    'Account Number: XXXXXXXX4021      IFSC: SBIN0001234      Branch: KORAMANGALA',
  ],
  right: 556,
  columns: [
    { header: 'Txn Date', x: 40, width: 58, align: 'left' },
    { header: 'Value Date', x: 102, width: 58, align: 'left' },
    { header: 'Description', x: 164, width: 186, align: 'left' },
    { header: 'Ref No./Cheque No.', x: 354, width: 70, align: 'left' },
    { header: 'Debit', x: 428, width: 56, align: 'right' },
    { header: 'Credit', x: 488, width: 0, align: 'right' },
    { header: 'Balance', x: 488, width: 68, align: 'right' },
  ],
  cells: (t, balance) => [
    ddMon(t.date),
    ddMon(t.postedDate ?? t.date),
    t.description,
    ref(t, 'TRF'),
    t.amount > 0 ? inr(t.amount) : '',
    '',
    inr(balance),
  ],
};

// SBI prints debit and credit in the same physical column on this layout, with
// a "(Cr)" marker — so the credit column above is zero-width and unused.
const SBI_WITH_CREDIT: TableLayout = {
  ...SBI,
  columns: SBI.columns.filter((c) => c.width > 0),
  cells: (t, balance) => [
    ddMon(t.date),
    ddMon(t.postedDate ?? t.date),
    t.description,
    ref(t, 'TRF'),
    t.amount > 0 ? inr(t.amount) : `${inr(-t.amount)} (Cr)`,
    inr(balance),
  ],
};

// ---------------------------------------------------------------------------
// HDFC — a value date between the reference and the amounts
// ---------------------------------------------------------------------------

function hdfc(from: string, to: string): TableLayout {
  return {
    title: 'HDFC BANK LIMITED',
    preamble: [
      'Statement of account',
      `Account No: 50100123456789      Statement period: ${ddmmyyyy(from)} to ${ddmmyyyy(to)}`,
      'Branch: INDIRANAGAR, BENGALURU      IFSC: HDFC0000123',
    ],
    right: 556,
    columns: [
      { header: 'Date', x: 40, width: 48, align: 'left' },
      { header: 'Narration', x: 92, width: 176, align: 'left' },
      { header: 'Chq./Ref.No.', x: 272, width: 68, align: 'left' },
      { header: 'Value Dt', x: 344, width: 46, align: 'left' },
      { header: 'Withdrawal Amt.', x: 392, width: 60, align: 'right' },
      { header: 'Deposit Amt.', x: 456, width: 44, align: 'right' },
      { header: 'Closing Balance', x: 504, width: 52, align: 'right' },
    ],
    cells: (t, balance) => [
      ddmmyy(t.date),
      t.description,
      ref(t, 'REF'),
      ddmmyy(t.postedDate ?? t.date),
      t.amount > 0 ? inr(t.amount) : '',
      t.amount < 0 ? inr(-t.amount) : '',
      inr(balance),
    ],
  };
}

// ---------------------------------------------------------------------------
// Axis — a fourth bank, deliberately unclaimed by any adapter
// ---------------------------------------------------------------------------

const AXIS: TableLayout = {
  title: 'AXIS BANK',
  preamble: [
    'Statement of Account',
    'Account No: 917010012345678      Period: 01-03-2026 to 30-04-2026',
  ],
  right: 556,
  columns: [
    { header: 'Tran Date', x: 40, width: 56, align: 'left' },
    { header: 'Particulars', x: 100, width: 200, align: 'left' },
    { header: 'Chq No', x: 304, width: 60, align: 'left' },
    { header: 'Withdrawals', x: 368, width: 60, align: 'right' },
    { header: 'Deposits', x: 432, width: 56, align: 'right' },
    { header: 'Balance', x: 492, width: 64, align: 'right' },
  ],
  cells: (t, balance) => [
    ddmmyyyy(t.date),
    t.description,
    ref(t, 'CHQ'),
    t.amount > 0 ? inr(t.amount) : '',
    t.amount < 0 ? inr(-t.amount) : '',
    inr(balance),
  ],
};

// ---------------------------------------------------------------------------
// PhonePe — blocks, not a table
// ---------------------------------------------------------------------------

function buildPhonePe(rows: GeneratedTransaction[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'PhonePe Statement' } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(14).text('PhonePe', 40, 40);
    doc.font('Helvetica').fontSize(9).text('Transaction Statement', 40, 58);
    doc.fontSize(8).text('Mar 01, 2026 - Apr 30, 2026', 40, 72);
    doc.text('Phone: +91 XXXXX 43210', 40, 84);
    doc.moveTo(40, 100).lineTo(556, 100).stroke();
    return 110;
  };

  let y = header();

  for (const t of rows) {
    if (y > 760) {
      doc.addPage();
      y = header();
    }

    const outgoing = t.amount > 0;
    const who = t.normalizedMerchant;

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(monDComma(t.date), 40, y, { lineBreak: false });
    doc.text(`${outgoing ? 'Paid to' : 'Received from'} ${who}`, 120, y, { lineBreak: false });
    doc.text(`${outgoing ? 'DEBIT' : 'CREDIT'}  INR ${inr(Math.abs(t.amount))}`, 400, y, {
      width: 156,
      align: 'right',
      lineBreak: false,
    });

    doc.font('Helvetica').fontSize(7.5);
    doc.text(`Transaction ID T${String(t.row).padStart(16, '0')}`, 120, y + 11, {
      lineBreak: false,
    });
    doc.text(`UTR ${String(600000000000 + t.row * 37)}`, 300, y + 11, { lineBreak: false });
    doc.text(`UPI ID: ${vpa(who)}`, 120, y + 21, { lineBreak: false });
    doc.text('Paid by: XXXXXXXX4021', 300, y + 21, { lineBreak: false });

    y += 38;
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------

/** Rows whose date falls in the given month, YYYY-MM. */
const inMonth = (rows: GeneratedTransaction[], month: string) =>
  rows.filter((t) => t.date.startsWith(month));

async function main() {
  const dataset = generateDataset();

  const write = async (name: string, content: Promise<Buffer>, note: string) => {
    const buffer = await content;
    writeFileSync(join(OUT, name), buffer);
    console.log(`  ${name.padEnd(34)} ${note}`);
  };

  console.log('Wrote to test-data/:');

  const sbiRows = dataset.slice(0, 45);
  await write('statement_sbi.pdf', buildTable(SBI_WITH_CREDIT, sbiRows), `${sbiRows.length} rows`);

  const hdfcRows = inMonth(dataset, '2026-03');
  await write(
    'statement_hdfc.pdf',
    buildTable(hdfc('2026-03-01', '2026-03-31'), hdfcRows),
    `${hdfcRows.length} rows`,
  );

  const phonePeRows = dataset.slice(0, 30);
  await write('statement_phonepe.pdf', buildPhonePe(phonePeRows), `${phonePeRows.length} rows`);

  const axisRows = dataset.slice(0, 40);
  await write(
    'statement_axis.pdf',
    buildTable(AXIS, axisRows),
    `${axisRows.length} rows (no adapter)`,
  );

  // --- the quarterly batch ------------------------------------------------
  // May repeats the last three days of April, as a real statement often does.
  const april = inMonth(dataset, '2026-04');
  const may = inMonth(dataset, '2026-05');
  const june = inMonth(dataset, '2026-06');
  const aprilTail = april.filter((t) => t.date >= '2026-04-28');
  const mayWithOverlap = [...aprilTail, ...may];

  await write(
    'statement_hdfc_2026_04.pdf',
    buildTable(hdfc('2026-04-01', '2026-04-30'), april),
    `${april.length} rows`,
  );
  await write(
    'statement_hdfc_2026_05.pdf',
    buildTable(hdfc('2026-04-28', '2026-05-31'), mayWithOverlap),
    `${mayWithOverlap.length} rows (${aprilTail.length} repeated from April)`,
  );
  await write(
    'statement_hdfc_2026_06.pdf',
    buildTable(hdfc('2026-06-01', '2026-06-30'), june),
    `${june.length} rows`,
  );
}

void main();
