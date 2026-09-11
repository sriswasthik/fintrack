import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadPage } from '@/pages/UploadPage';
import type * as StatementsModule from '@/lib/statements';
import type { BatchPreview, BatchRow } from '@/lib/statements';
import { inspectStatement, parseStatement, parseStatementBatch } from '@/lib/statements';
import {
  commitImport,
  fetchAccounts,
  uploadCsv,
  type PreviewRow,
  type UploadPreview,
} from '@/lib/transactions';

// The module only exports these three functions plus types, so a plain factory
// is enough — nothing else needs to survive the mock.
vi.mock('@/lib/transactions', () => ({
  fetchAccounts: vi.fn(),
  uploadCsv: vi.fn(),
  commitImport: vi.fn(),
}));

vi.mock('@/lib/statements', async (importOriginal) => {
  const actual = await importOriginal<typeof StatementsModule>();
  return {
    ...actual,
    inspectStatement: vi.fn(),
    parseStatement: vi.fn(),
    parseStatementBatch: vi.fn(),
  };
});

const fetchAccountsMock = vi.mocked(fetchAccounts);
const inspectStatementMock = vi.mocked(inspectStatement);
const parseStatementMock = vi.mocked(parseStatement);
const parseStatementBatchMock = vi.mocked(parseStatementBatch);
const uploadCsvMock = vi.mocked(uploadCsv);
const commitImportMock = vi.mocked(commitImport);

function row(index: number, overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    index,
    date: '2026-03-01',
    postedDate: null,
    description: 'SQ *JOES COFFEE',
    rawMerchant: 'SQ *JOES COFFEE',
    normalizedMerchant: 'JOES COFFEE',
    amount: 5.25,
    duplicate: null,
    ...overrides,
  };
}

const PREVIEW: UploadPreview = {
  status: 'preview',
  fileName: 'export.csv',
  accountId: 'acct_1',
  preset: 'generic',
  headers: ['date', 'description', 'amount'],
  mapping: {
    date: 'date',
    description: 'description',
    amount: 'amount',
    amountSign: 'debit-positive',
  },
  totalRows: 3,
  duplicateCount: 1,
  skippedRows: [],
  rows: [
    row(1),
    row(2, {
      description: 'WHOLE FOODS MKT #104',
      normalizedMerchant: 'WHOLE FOODS',
      amount: 64.18,
    }),
    row(3, {
      duplicate: {
        kind: 'in-file',
        matchesRowIndex: 1,
        existingDate: '2026-03-01',
        reason: 'Same amount and merchant as row 1 in this file',
      },
    }),
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<UploadPage />, { wrapper });
}

/** Picks the account and attaches a file, leaving the page ready to upload. */
async function chooseAccountAndFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByLabelText('Account'));
  await user.click(await screen.findByRole('option', { name: 'Everyday Checking' }));
  const file = new File(['date,description,amount\n2026-03-01,X,1.00\n'], 'export.csv', {
    type: 'text/csv',
  });
  await user.upload(screen.getByLabelText('CSV or PDF file'), file);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchAccountsMock.mockResolvedValue([
    { id: 'acct_1', name: 'Everyday Checking', type: 'CHECKING' },
    { id: 'acct_2', name: 'Sapphire Credit Card', type: 'CREDIT_CARD' },
  ]);
  uploadCsvMock.mockResolvedValue(PREVIEW);
  commitImportMock.mockResolvedValue({ accountId: 'acct_1', imported: 2, skipped: 1 });
});

describe('UploadPage', () => {
  it('cannot upload until an account and a file are chosen', async () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('uploads the chosen file against the chosen account', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(uploadCsvMock).toHaveBeenCalledTimes(1));
    expect(uploadCsvMock.mock.calls[0][0]).toMatchObject({ accountId: 'acct_1' });
    expect(uploadCsvMock.mock.calls[0][0].file.name).toBe('export.csv');
  });

  it('renders the preview and flags the duplicate row', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(/704|3 rows parsed from/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Flagged duplicates \(1\)/ })).toBeInTheDocument();

    const flagged = screen.getAllByRole('row').find((r) => within(r).queryByText('duplicate'));
    expect(flagged).toBeDefined();
    expect(within(flagged!).getByRole('button', { name: /row 3/ })).toHaveTextContent('Skipped');
  });

  it('defaults flagged rows to skip and says how many will be imported', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(
      await screen.findByText(/2 of 3 rows will be imported, 1 skipped\./),
    ).toBeInTheDocument();
  });

  it('lets the user keep a flagged row', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await user.click(await screen.findByRole('button', { name: /Keep row 3/ }));

    expect(await screen.findByText(/3 of 3 rows will be imported\./)).toBeInTheDocument();
  });

  it('commits every row with the resolutions the user chose', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await user.click(await screen.findByRole('button', { name: 'Confirm Import' }));

    await waitFor(() => expect(commitImportMock).toHaveBeenCalledTimes(1));
    expect(commitImportMock.mock.calls[0][0]).toMatchObject({
      accountId: 'acct_1',
      resolutions: { 3: 'skip' },
    });
    // All rows are sent, not just the 20 shown in the table.
    expect(commitImportMock.mock.calls[0][0].rows).toHaveLength(3);
  });

  it('reports the result once the import completes', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm Import' }));

    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText(/Imported 2 transaction\(s\), skipped 1\./)).toBeInTheDocument();
  });

  it('shows the column-mapping form when the server does not recognise the headers', async () => {
    uploadCsvMock.mockResolvedValue({
      status: 'needs-mapping',
      fileName: 'weird.csv',
      headers: ['Posted', 'Merchant Name', 'Debit'],
      sampleRows: [{ Posted: '2026-03-01', 'Merchant Name': 'ACME', Debit: '10.00' }],
      requiredFields: ['date', 'description', 'amount'],
      knownPresets: [],
    });

    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Map the columns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Parse with this mapping' })).toBeDisabled();
  });

  it('surfaces a server error', async () => {
    uploadCsvMock.mockRejectedValue({
      response: { data: { error: 'The uploaded file is empty' } },
    });

    const user = userEvent.setup();
    renderPage();
    await chooseAccountAndFile(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The uploaded file is empty');
  });
});

// ---------------------------------------------------------------------------
// PDF statements — the password is asked for only when there is one to ask for
// ---------------------------------------------------------------------------

const pdf = (name = 'statement.pdf') =>
  new File(['%PDF-1.4 pretend'], name, { type: 'application/pdf' });

const PDF_PREVIEW: UploadPreview = { ...PREVIEW, fileName: 'statement.pdf', rows: [row(1)] };

/** Selects an account and the given file, then waits for inspection to settle. */
async function choosePdf(user: ReturnType<typeof userEvent.setup>, file = pdf()) {
  await user.click(screen.getByLabelText('Account'));
  await user.click(await screen.findByRole('option', { name: 'Everyday Checking' }));
  await user.upload(screen.getByLabelText('CSV or PDF file'), file);
}

describe('PDF statements', () => {
  beforeEach(() => {
    inspectStatementMock.mockResolvedValue({ requiresPassword: false });
    parseStatementMock.mockResolvedValue(PDF_PREVIEW);
  });

  it('inspects the file as soon as it is chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await choosePdf(user);

    await waitFor(() => expect(inspectStatementMock).toHaveBeenCalledOnce());
    expect(inspectStatementMock.mock.calls[0][0].name).toBe('statement.pdf');
  });

  it('asks for no password when the file does not need one', async () => {
    const user = userEvent.setup();
    renderPage();
    await choosePdf(user);

    expect(await screen.findByText(/not password-protected/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Statement password')).not.toBeInTheDocument();

    // And it can be uploaded straight away, with no password sent.
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(parseStatementMock).toHaveBeenCalledOnce());
    expect(parseStatementMock.mock.calls[0][0]).not.toHaveProperty('password');
  });

  it('reveals a password field only for an encrypted file', async () => {
    inspectStatementMock.mockResolvedValue({ requiresPassword: true });
    const user = userEvent.setup();
    renderPage();
    await choosePdf(user);

    expect(await screen.findByLabelText('Statement password')).toBeInTheDocument();
    // ...and will not let the file be sent until one is typed.
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();

    await user.type(screen.getByLabelText('Statement password'), 'open-sesame');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(parseStatementMock).toHaveBeenCalledOnce());
    expect(parseStatementMock.mock.calls[0][0].password).toBe('open-sesame');
  });

  it('says specifically that the password was wrong', async () => {
    inspectStatementMock.mockResolvedValue({ requiresPassword: true });
    parseStatementMock.mockRejectedValue({
      response: {
        data: {
          error: 'That password did not open the statement. Check it and try again.',
          details: { reason: 'incorrect-password' },
        },
      },
    });

    const user = userEvent.setup();
    renderPage();
    await choosePdf(user);
    await user.type(await screen.findByLabelText('Statement password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/that password did not open the statement/i);
    // The distinction that matters: not "this file needs a password".
    expect(alert).not.toHaveTextContent(/is password-protected/i);
    expect(alert).toHaveTextContent(/nothing was imported/i);
  });

  it('leaves a CSV on the CSV path, with no inspection at all', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByLabelText('Account'));
    await user.click(await screen.findByRole('option', { name: 'Everyday Checking' }));
    await user.upload(
      screen.getByLabelText('CSV or PDF file'),
      new File(['date,description,amount'], 'export.csv', { type: 'text/csv' }),
    );

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(uploadCsvMock).toHaveBeenCalledOnce());
    expect(inspectStatementMock).not.toHaveBeenCalled();
    expect(parseStatementMock).not.toHaveBeenCalled();
  });

  it('forgets the password when a different file is chosen', async () => {
    inspectStatementMock.mockResolvedValue({ requiresPassword: true });
    const user = userEvent.setup();
    renderPage();
    await choosePdf(user);
    await user.type(await screen.findByLabelText('Statement password'), 'first-file-password');

    inspectStatementMock.mockResolvedValue({ requiresPassword: false });
    await user.upload(screen.getByLabelText('CSV or PDF file'), pdf('another.pdf'));

    expect(await screen.findByText(/not password-protected/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Statement password')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Statement period and batch import
// ---------------------------------------------------------------------------

const pdfFile = (name: string) => new File(['%PDF-1.4 pretend'], name, { type: 'application/pdf' });

const batchRow = (index: number, over: Partial<BatchRow> = {}): BatchRow => ({
  ...row(index),
  fileIndex: 0,
  fileName: 'april.pdf',
  counterpartyRaw: null,
  upiVpa: null,
  ...over,
});

const BATCH: BatchPreview = {
  status: 'batch-preview',
  accountId: 'acct_1',
  files: [
    {
      index: 0,
      fileName: 'april.pdf',
      status: 'parsed',
      source: 'hdfc',
      sourceLabel: 'HDFC Bank',
      via: 'adapter',
      rowCount: 2,
      skippedRows: [],
    },
    {
      index: 1,
      fileName: 'may.pdf',
      status: 'parsed',
      source: 'hdfc',
      sourceLabel: 'HDFC Bank',
      via: 'adapter',
      rowCount: 1,
      skippedRows: [],
    },
  ],
  filesParsed: 2,
  filesFailed: 0,
  totalRows: 3,
  duplicateCount: 1,
  crossFileDuplicateCount: 1,
  rows: [
    batchRow(1),
    batchRow(2),
    batchRow(3, {
      fileIndex: 1,
      fileName: 'may.pdf',
      duplicate: {
        kind: 'in-file',
        matchesRowIndex: 1,
        existingDate: '2026-03-01',
        reason: 'Same amount and merchant as a row in april.pdf',
      },
    }),
  ],
};

async function chooseAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Account'));
  await user.click(await screen.findByRole('option', { name: 'Everyday Checking' }));
}

async function choosePeriod(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByLabelText('Statement period'));
  await user.click(await screen.findByRole('option', { name: label }));
}

describe('statement period', () => {
  beforeEach(() => {
    inspectStatementMock.mockResolvedValue({ requiresPassword: false });
    parseStatementBatchMock.mockResolvedValue(BATCH);
  });

  it('takes one file a month, and several for a quarter', async () => {
    const user = userEvent.setup();
    renderPage();

    const single = screen.getByLabelText('CSV or PDF file');
    expect(single).not.toHaveAttribute('multiple');

    await choosePeriod(user, 'Quarterly');
    expect(await screen.findByLabelText('CSV or PDF files')).toHaveAttribute('multiple');
  });

  it('offers a custom range too', async () => {
    const user = userEvent.setup();
    renderPage();
    await choosePeriod(user, 'Custom range');
    expect(await screen.findByLabelText('CSV or PDF files')).toHaveAttribute('multiple');
  });

  it('sends every chosen file as one batch', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseAccount(user);
    await choosePeriod(user, 'Quarterly');

    await user.upload(screen.getByLabelText('CSV or PDF files'), [
      pdfFile('april.pdf'),
      pdfFile('may.pdf'),
      pdfFile('june.pdf'),
    ]);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(parseStatementBatchMock).toHaveBeenCalledOnce());
    expect(parseStatementBatchMock.mock.calls[0][0].files).toHaveLength(3);
    // One batch call, not one call per file.
    expect(parseStatementMock).not.toHaveBeenCalled();
  });

  it('does not inspect each file up front when several are chosen', async () => {
    // With one file the answer decides whether to show a password box before
    // uploading. With several, the batch preview answers it per file instead.
    const user = userEvent.setup();
    renderPage();
    await chooseAccount(user);
    await choosePeriod(user, 'Quarterly');

    await user.upload(screen.getByLabelText('CSV or PDF files'), [pdfFile('a.pdf'), pdfFile('b.pdf')]);

    expect(inspectStatementMock).not.toHaveBeenCalled();
  });
});

describe('the combined batch preview', () => {
  beforeEach(() => {
    inspectStatementMock.mockResolvedValue({ requiresPassword: false });
    parseStatementBatchMock.mockResolvedValue(BATCH);
  });

  async function runBatch(user: ReturnType<typeof userEvent.setup>, preview = BATCH) {
    parseStatementBatchMock.mockResolvedValue(preview);
    renderPage();
    await chooseAccount(user);
    await choosePeriod(user, 'Quarterly');
    await user.upload(screen.getByLabelText('CSV or PDF files'), [
      pdfFile('april.pdf'),
      pdfFile('may.pdf'),
    ]);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    return screen.findByRole('table', { name: 'Files in this import' });
  }

  it('lists every file with its detected format and status', async () => {
    const user = userEvent.setup();
    const table = await runBatch(user);

    expect(within(table).getByText('april.pdf')).toBeInTheDocument();
    expect(within(table).getByText('may.pdf')).toBeInTheDocument();
    expect(within(table).getAllByText('HDFC Bank')).toHaveLength(2);
    expect(within(table).getAllByText('Parsed OK')).toHaveLength(2);
  });

  it('says how many duplicates were repeated between files', async () => {
    const user = userEvent.setup();
    await runBatch(user);

    expect(await screen.findByText(/repeated between files/i)).toBeInTheDocument();
  });

  it('commits every file in one import', async () => {
    const user = userEvent.setup();
    await runBatch(user);

    await user.click(await screen.findByRole('button', { name: 'Confirm Import' }));

    await waitFor(() => expect(commitImportMock).toHaveBeenCalledOnce());
    const [call] = commitImportMock.mock.calls;
    expect(call[0].rows).toHaveLength(3);
    // The cross-file duplicate defaults to skip, like any other duplicate.
    expect(call[0].resolutions).toEqual({ 3: 'skip' });
  });

  it('shows a per-file password box for a locked file, and keeps the rest', async () => {
    const user = userEvent.setup();
    await runBatch(user, {
      ...BATCH,
      filesParsed: 1,
      filesFailed: 1,
      files: [
        BATCH.files[0],
        {
          ...BATCH.files[1],
          status: 'needs-password',
          source: null,
          sourceLabel: null,
          via: null,
          rowCount: 0,
          message: 'This statement is password-protected.',
        },
      ],
    });

    expect(await screen.findByText('Needs password')).toBeInTheDocument();
    expect(screen.getByLabelText('Password for may.pdf')).toBeInTheDocument();
    // The file that did parse is still importable.
    expect(screen.getByRole('button', { name: 'Confirm Import' })).toBeEnabled();
  });

  it('retries with the passwords the user typed', async () => {
    const user = userEvent.setup();
    await runBatch(user, {
      ...BATCH,
      filesParsed: 1,
      filesFailed: 1,
      files: [BATCH.files[0], { ...BATCH.files[1], status: 'needs-password', rowCount: 0 }],
    });

    await user.type(await screen.findByLabelText('Password for may.pdf'), 'hunter2');
    await user.click(screen.getByRole('button', { name: /retry the files that failed/i }));

    await waitFor(() => expect(parseStatementBatchMock).toHaveBeenCalledTimes(2));
    expect(parseStatementBatchMock.mock.calls[1][0].passwords).toEqual({ 1: 'hunter2' });
  });
});
