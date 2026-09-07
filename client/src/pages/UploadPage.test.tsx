import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadPage } from '@/pages/UploadPage';
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

const fetchAccountsMock = vi.mocked(fetchAccounts);
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
  await user.upload(screen.getByLabelText('CSV file'), file);
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
