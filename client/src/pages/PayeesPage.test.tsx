import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PayeesPage } from '@/pages/PayeesPage';
import { fetchPayee, fetchPayees, type Payee, type PayeeDetail } from '@/lib/payees';

vi.mock('@/lib/payees', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), fetchPayees: vi.fn(), fetchPayee: vi.fn() };
});

const fetchPayeesMock = vi.mocked(fetchPayees);
const fetchPayeeMock = vi.mocked(fetchPayee);

const SAM: Payee = {
  id: 'payee_sam',
  displayName: 'SAM R',
  upiVpa: null,
  phone: null,
  type: 'PERSON',
  paid: 4750.5,
  received: 3900.25,
  net: 850.25,
  transactions: 4,
  lastTransactionAt: '2026-07-19',
  firstTransactionAt: '2026-05-06',
};

const PRIYA: Payee = {
  id: 'payee_priya',
  displayName: 'PRIYA N',
  upiVpa: 'priya@okaxis',
  phone: null,
  type: 'PERSON',
  paid: 6000,
  received: 6000,
  net: 0,
  transactions: 2,
  lastTransactionAt: '2026-06-08',
  firstTransactionAt: '2026-06-02',
};

const SWIGGY: Payee = {
  id: 'payee_swiggy',
  displayName: 'SWIGGY',
  upiVpa: null,
  phone: null,
  type: 'BUSINESS',
  paid: 1135.75,
  received: 0,
  net: 1135.75,
  transactions: 2,
  lastTransactionAt: '2026-06-17',
  firstTransactionAt: '2026-06-03',
};

const SAM_DETAIL: PayeeDetail = {
  ...SAM,
  transactionHistory: [
    {
      id: 't4',
      accountId: 'acct_1',
      accountName: 'Everyday Checking',
      date: '2026-07-19',
      description: 'PAYTM WALLET FROM SAM R',
      normalizedMerchant: 'PAYTM WALLET',
      amount: -400.25,
      category: 'TRANSFER',
      direction: 'received',
    },
    {
      id: 't3',
      accountId: 'acct_1',
      accountName: 'Everyday Checking',
      date: '2026-07-02',
      description: 'PAYTM WALLET TO SAM R',
      normalizedMerchant: 'PAYTM WALLET',
      amount: 1250.5,
      category: 'TRANSFER',
      direction: 'paid',
    },
  ],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PayeesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchPayeesMock.mockResolvedValue([SAM, PRIYA, SWIGGY]);
  fetchPayeeMock.mockResolvedValue(SAM_DETAIL);
});

describe('PayeesPage', () => {
  it('lists every payee with what went each way', async () => {
    renderPage();

    const row = await screen.findByRole('row', { name: /SAM R/ });
    // Phase 18: paid is a debit, received is a credit, and net carries its own
    // sign — being out of pocket with somebody is the red one.
    expect(within(row).getByText('\u2212₹4,750.50')).toHaveClass('text-negative');
    expect(within(row).getByText('+₹3,900.25')).toHaveClass('text-positive');
    expect(within(row).getByText('\u2212₹850.25')).toHaveClass('text-negative');
  });

  it('colours a payee you owe money to the other way round', async () => {
    fetchPayeesMock.mockResolvedValue([{ ...SAM, paid: 100, received: 900, net: -800 }]);
    renderPage();

    const row = await screen.findByRole('row', { name: /SAM R/ });
    expect(within(row).getByText('+₹800.00')).toHaveClass('text-positive');
  });

  it('shows a settled round trip as a net of zero rather than hiding it', async () => {
    renderPage();

    const row = await screen.findByRole('row', { name: /PRIYA N/ });
    // Paid and received are both ₹6,000; the zero net is the useful part, and
    // it stays uncoloured because square is neither direction.
    expect(within(row).getByText('\u2212₹6,000.00')).toBeInTheDocument();
    expect(within(row).getByText('+₹6,000.00')).toBeInTheDocument();
    const net = within(row).getByText('₹0.00');
    expect(net).not.toHaveClass('text-negative');
    expect(net).not.toHaveClass('text-positive');
  });

  it('labels a person and a business differently', async () => {
    renderPage();

    const sam = await screen.findByRole('row', { name: /SAM R/ });
    const swiggy = screen.getByRole('row', { name: /SWIGGY/ });
    expect(within(sam).getByText('Person')).toBeInTheDocument();
    expect(within(swiggy).getByText('Business')).toBeInTheDocument();
  });

  it('sends the search to the server so it can match a UPI address too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('row', { name: /SAM R/ });

    await user.type(screen.getByLabelText('Search payees'), 'sam');

    await waitFor(() =>
      expect(fetchPayeesMock).toHaveBeenCalledWith(expect.objectContaining({ q: 'sam' })),
    );
  });

  it('asks the server to re-sort rather than reordering what it has', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('row', { name: /SAM R/ });

    await user.click(screen.getByLabelText('Sort by'));
    await user.click(await screen.findByRole('option', { name: /Sort: Name/ }));

    await waitFor(() =>
      expect(fetchPayeesMock).toHaveBeenCalledWith(expect.objectContaining({ sort: 'name' })),
    );
  });

  it('filters people from businesses without another request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('row', { name: /SAM R/ });
    const before = fetchPayeesMock.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'People' }));

    expect(screen.queryByRole('row', { name: /SWIGGY/ })).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /SAM R/ })).toBeInTheDocument();
    expect(fetchPayeesMock.mock.calls).toHaveLength(before);
  });

  it('opens one payee’s full history', async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByRole('row', { name: /SAM R/ });

    await user.click(within(row).getByRole('button', { name: 'History' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('PAYTM WALLET FROM SAM R')).toBeInTheDocument();
    expect(within(dialog).getByText('PAYTM WALLET TO SAM R')).toBeInTheDocument();
    expect(within(dialog).getByText('Paid to them')).toBeInTheDocument();
    expect(within(dialog).getByText('Received from them')).toBeInTheDocument();
    expect(fetchPayeeMock).toHaveBeenCalledWith('payee_sam');
  });

  it('says which way the ledger leans', async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByRole('row', { name: /SAM R/ });
    await user.click(within(row).getByRole('button', { name: 'History' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('You are out of pocket')).toBeInTheDocument();
  });

  it('says nothing is owed when a round trip has settled', async () => {
    fetchPayeeMock.mockResolvedValue({ ...PRIYA, transactionHistory: [] });
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByRole('row', { name: /PRIYA N/ });
    await user.click(within(row).getByRole('button', { name: 'History' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Square')).toBeInTheDocument();
  });

  it('explains an empty ledger rather than showing an empty table', async () => {
    fetchPayeesMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('Nobody here yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when a search matched nothing, and what was searched for', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('row', { name: /SAM R/ });

    fetchPayeesMock.mockResolvedValue([]);
    await user.type(screen.getByLabelText('Search payees'), 'zzz');

    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.getByText(/zzz/)).toBeInTheDocument();
  });

  it('offers a retry when the ledger will not load', async () => {
    fetchPayeesMock.mockRejectedValue(new Error('nope'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again|Retry/i })).toBeInTheDocument();
  });
});
