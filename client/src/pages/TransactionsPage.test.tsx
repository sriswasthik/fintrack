import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TransactionsPage } from '@/pages/TransactionsPage';
import {
  downloadTransactionsCsv,
  fetchAccounts,
  fetchTransactions,
  type Transaction,
  type TransactionPage,
} from '@/lib/transactions';

vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAccounts: vi.fn(),
  fetchTransactions: vi.fn(),
  downloadTransactionsCsv: vi.fn(),
}));

const fetchAccountsMock = vi.mocked(fetchAccounts);
const fetchTransactionsMock = vi.mocked(fetchTransactions);
const downloadMock = vi.mocked(downloadTransactionsCsv);

function txn(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    accountId: 'acct_1',
    date: '2026-06-12',
    postedDate: '2026-06-13',
    description: 'UPI/SWIGGY/412345678901',
    rawMerchant: 'SWIGGY',
    normalizedMerchant: 'SWIGGY',
    amount: 450,
    currency: 'INR',
    category: 'DINING',
    confidence: 1,
    source: 'RULE',
    transferPairId: null,
    linkedRefundId: null,
    splits: [],
    ...overrides,
  };
}

function page(
  transactions: Transaction[],
  total = transactions.length,
  offset = 0,
): TransactionPage {
  return { total, limit: 50, offset, transactions };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return render(<TransactionsPage />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchAccountsMock.mockResolvedValue([
    { id: 'acct_1', name: 'HDFC Savings', type: 'CHECKING' },
    { id: 'acct_2', name: 'ICICI Card', type: 'CREDIT_CARD' },
  ]);
  fetchTransactionsMock.mockResolvedValue(
    page([
      txn('t1'),
      txn('t2', {
        description: 'NEFT/NORTHWIND LABS SALARY',
        normalizedMerchant: 'NORTHWIND LABS',
        amount: -85000,
        category: 'INCOME',
      }),
      txn('t3', {
        description: 'OWN ACCOUNT MOVE',
        category: 'TRANSFER',
        transferPairId: 't9',
        source: 'MANUAL',
        splits: [
          { id: 's1', category: 'GROCERIES', amount: 200, note: null },
          { id: 's2', category: 'SHOPPING', amount: 250, note: null },
        ],
      }),
    ]),
  );
  downloadMock.mockResolvedValue('fintrack-transactions-all.csv');
});

describe('TransactionsPage', () => {
  it('lists what the server returned, with the count', async () => {
    renderPage();

    expect(await screen.findByText('3 transactions')).toBeInTheDocument();
    expect(screen.getByText('UPI/SWIGGY/412345678901')).toBeInTheDocument();
    expect(screen.getByText('NEFT/NORTHWIND LABS SALARY')).toBeInTheDocument();
  });

  it('signs and colours money out and money in differently', async () => {
    renderPage();
    const out = (await screen.findByText('UPI/SWIGGY/412345678901')).closest('tr')!;
    const inn = screen.getByText('NEFT/NORTHWIND LABS SALARY').closest('tr')!;

    expect(within(out).getByText(/−₹450\.00/)).toBeInTheDocument();
    expect(within(inn).getByText(/\+₹85,000\.00/)).toBeInTheDocument();
  });

  it('marks a split, a manual correction and a paired transfer', async () => {
    renderPage();
    const row = (await screen.findByText('OWN ACCOUNT MOVE')).closest('tr')!;

    expect(within(row).getByText('split 2')).toBeInTheDocument();
    expect(within(row).getByText('manual')).toBeInTheDocument();
    expect(within(row).getByText('paired')).toBeInTheDocument();
  });

  it('filters by account, from the first page', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('3 transactions');

    await user.click(screen.getByLabelText('Account filter'));
    await user.click(await screen.findByRole('option', { name: 'ICICI Card' }));

    await waitFor(() =>
      expect(fetchTransactionsMock).toHaveBeenLastCalledWith({
        accountId: 'acct_2',
        limit: 50,
        offset: 0,
      }),
    );
  });

  it('pages through a long list', async () => {
    const user = userEvent.setup();
    fetchTransactionsMock.mockResolvedValue(page([txn('t1')], 120));
    renderPage();

    expect(await screen.findByText('Showing 1–50')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(fetchTransactionsMock).toHaveBeenLastCalledWith({ limit: 50, offset: 50 }),
    );
  });

  it('exports what the filter matches as a CSV', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('3 transactions');

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith({}));

    await user.click(screen.getByLabelText('Account filter'));
    await user.click(await screen.findByRole('option', { name: 'HDFC Savings' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(downloadMock).toHaveBeenLastCalledWith({ accountId: 'acct_1' }));
  });

  it('says so when an export fails', async () => {
    const user = userEvent.setup();
    downloadMock.mockRejectedValue({ response: { data: { error: 'Too many requests' } } });
    renderPage();
    await screen.findByText('3 transactions');

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
  });

  it('offers the import page when there is nothing yet, and nothing to export', async () => {
    fetchTransactionsMock.mockResolvedValue(page([]));
    renderPage();

    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import a statement' })).toHaveAttribute(
      'href',
      '/upload',
    );
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  it('surfaces a failure to load, with a retry', async () => {
    fetchTransactionsMock.mockRejectedValue({ response: { data: { error: 'Database is down' } } });
    renderPage();

    expect(await screen.findByText('Database is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
