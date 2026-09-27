import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '@/pages/DashboardPage';
import { fetchDashboard, type Dashboard } from '@/lib/dashboard';
import { fetchAccounts, fetchTransactions } from '@/lib/transactions';
import { fetchTotals } from '@/lib/totals';
import { fetchIndiaInsights, type IndiaInsights } from '@/lib/india';

// This component adapts to a read-only demo session; these tests are about a
// normal one. (The demo behaviour has its own tests.)
vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'user_1', email: 'alice@example.test', name: 'Alice' },
    isRestoring: false,
    isDemo: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    startDemo: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// Recharts measures its container, which jsdom cannot do, so the two chart
// components are stubbed. Their own logic is covered by slices.test.ts.
vi.mock('@/components/dashboard/CategoryBars', () => ({
  CategoryBars: ({ onSelect }: { onSelect: (c: string) => void }) => (
    <button onClick={() => onSelect('SHOPPING')}>bars: SHOPPING</button>
  ),
}));
vi.mock('@/components/dashboard/SpendOverTime', () => ({
  SpendOverTime: ({ granularity }: { granularity: string }) => <div>chart:{granularity}</div>,
}));

vi.mock('@/lib/dashboard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchDashboard: vi.fn(),
}));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAccounts: vi.fn(),
  fetchTransactions: vi.fn(),
}));
// The range-totals widget runs its own query on its own window (Phase 18). It
// has its own tests; here it only needs to not reach the network.
vi.mock('@/lib/totals', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchTotals: vi.fn(),
}));
// Phase 19's five statistics-only features. They have their own component and
// detector suites; here the page only has to place them.
vi.mock('@/lib/india', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchIndiaInsights: vi.fn(),
}));

const fetchDashboardMock = vi.mocked(fetchDashboard);
const fetchAccountsMock = vi.mocked(fetchAccounts);
const fetchTransactionsMock = vi.mocked(fetchTransactions);
const fetchTotalsMock = vi.mocked(fetchTotals);
const fetchIndiaMock = vi.mocked(fetchIndiaInsights);

/** The hand-verified June figures. */
const JUNE: Dashboard = {
  range: { from: '2026-06-01', to: '2026-06-30', month: '2026-06', granularity: 'daily' },
  previousRange: { from: '2026-05-01', to: '2026-05-31' },
  filters: { accountId: null, categories: null },
  totals: { spend: 8959.49, income: 10926.72, net: 1967.23, transactions: 111 },
  previous: { spend: 13295.66, income: 8225.77, net: -5069.89, transactions: 124 },
  deltas: { spend: -32.6, income: 32.8 },
  byCategory: [
    { category: 'HOUSING', amount: 2150, transactions: 1, share: 24 },
    { category: 'SHOPPING', amount: 1945.84, transactions: 18, share: 21.7 },
    { category: 'INCOME', amount: -10926.72, transactions: 4, share: 0 },
  ],
  series: [{ date: '2026-06-01', spend: 2550.12 }],
  topMerchants: [{ merchant: 'OAKWOOD PROPERTY MGMT', amount: 2150, transactions: 1 }],
  availableMonths: ['2026-05', '2026-06', '2026-07'],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<DashboardPage />, { wrapper });
}

const lastParams = () => fetchDashboardMock.mock.calls[fetchDashboardMock.mock.calls.length - 1][0];

const INDIA: IndiaInsights = {
  month: '2026-06',
  salary: {
    payer: 'INFOSYS LTD',
    monthlyAmount: 120908.34,
    payDay: 15,
    creditsPerMonth: 2,
    months: [],
    presentInMonth: true,
    lastPaidMonth: '2026-06',
  },
  savings: { month: '2026-06', income: 120000, expense: 90000, saved: 30000, rate: 0.25 },
  loans: {
    loans: [
      {
        merchant: 'BAJAJ FINANCE EMI',
        monthlyAmount: 18450,
        debitDay: 5,
        firstSeen: '2026-03-05',
        lastSeen: '2026-06-05',
        instalmentsObserved: 4,
        active: true,
        nextInstalment: '2026-07-05',
        estimate: {
          assumedTenureMonths: 6,
          remainingMonths: 2,
          projectedFinalMonth: '2026-08',
          caveat: 'Estimate only. Assumes this loan began with the first instalment.',
        },
      },
    ],
    totalMonthly: 18450,
    shareOfIncome: 0.153,
  },
  investments: {
    plans: [
      {
        merchant: 'ZERODHA COIN SIP',
        monthlyAmount: 5000,
        debitDay: 7,
        firstSeen: '2026-03-07',
        lastSeen: '2026-06-07',
        contributionsObserved: 4,
        active: true,
      },
    ],
    totalMonthly: 5000,
    shareOfIncome: 0.041,
  },
  upcoming: {
    bills: [
      {
        merchant: 'JIO FIBER',
        category: 'UTILITIES',
        expectedDate: '2026-07-05',
        expectedAmount: 899,
        lastCharged: '2026-06-05',
        cadenceDays: 30,
        expectedDay: 5,
        confidence: 'high',
        observations: 4,
      },
    ],
    totalExpected: 899,
  },
  festive: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchIndiaMock.mockResolvedValue(INDIA);
  fetchDashboardMock.mockResolvedValue(JUNE);
  fetchTotalsMock.mockResolvedValue({
    range: { kind: 'monthly', startDate: '2026-06-01', endDate: '2026-06-30', month: '2026-06' },
    filters: { accountId: null },
    totalDebits: 173967.09,
    totalCredits: 234010.1,
    net: -60043.01,
    transactionCount: 111,
  });
  fetchAccountsMock.mockResolvedValue([
    { id: 'acct_1', name: 'Everyday Checking', type: 'CHECKING' },
    { id: 'acct_2', name: 'Sapphire Credit Card', type: 'CREDIT_CARD' },
  ]);
  fetchTransactionsMock.mockResolvedValue({
    total: 1,
    limit: 200,
    offset: 0,
    transactions: [
      {
        id: 't1',
        accountId: 'acct_1',
        date: '2026-06-01',
        postedDate: null,
        description: 'OAKWOOD PROPERTY MGMT',
        rawMerchant: 'OAKWOOD PROPERTY MGMT',
        normalizedMerchant: 'OAKWOOD PROPERTY MGMT',
        amount: 2150,
        currency: 'INR',
        category: 'HOUSING',
        confidence: 1,
        source: 'RULE',
        transferPairId: null,
        linkedRefundId: null,
        splits: [],
      },
    ],
  });
});

describe('DashboardPage', () => {
  it('leads with the headline totals and their change', async () => {
    renderPage();

    expect(await screen.findByText('₹8,959.49')).toBeInTheDocument();
    expect(screen.getByText('₹10,926.72')).toBeInTheDocument();
    expect(screen.getByText('₹1,967.23')).toBeInTheDocument();
    expect(screen.getByText('111')).toBeInTheDocument();
  });

  it('shows the direction of change with an arrow as well as colour', async () => {
    renderPage();

    // Spending down is good; income up is good. Both carry a glyph so the
    // meaning never rests on hue alone.
    expect(await screen.findByText('↓ 32.6%')).toBeInTheDocument();
    expect(screen.getByText('↑ 32.8%')).toBeInTheDocument();
  });

  it('does not claim "no prior period" for a metric that has no comparison', async () => {
    renderPage();
    await screen.findByText('₹1,967.23');
    expect(screen.queryByText('no prior period')).not.toBeInTheDocument();
  });

  it('lists every category at full precision, including one left negative', async () => {
    renderPage();
    // The tables render empty before the data lands, so wait for the data.
    await screen.findByText('₹8,959.49');

    // Scope by the table's own header rather than by position.
    const tables = await screen.findAllByRole('table');
    const categoryTable = tables.find((t) => within(t).queryByText('Share'))!;

    expect(within(categoryTable).getByText('HOUSING')).toBeInTheDocument();
    expect(within(categoryTable).getByText('-₹10,926.72')).toBeInTheDocument();
    // INCOME is listed but carries no share of spending.
    expect(within(categoryTable).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('refetches through React Query when the account filter changes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    await user.click(screen.getByRole('combobox', { name: 'Account' }));
    await user.click(await screen.findByRole('option', { name: 'Sapphire Credit Card' }));

    await waitFor(() => expect(lastParams()).toMatchObject({ accountId: 'acct_2' }));
  });

  it('passes a category filter through as a list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'DINING' }));

    await waitFor(() => expect(lastParams()).toMatchObject({ categories: ['DINING'] }));
  });

  it('offers to clear filters only once one is set', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'DINING' }));
    await user.click(await screen.findByRole('button', { name: 'Clear filters' }));

    await waitFor(() => expect(lastParams().categories).toBeUndefined());
  });

  it('steps between months with the arrows', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ month: '2026-05' }));
  });

  it('disables stepping past the ends of the available months', async () => {
    fetchDashboardMock.mockResolvedValue({
      ...JUNE,
      range: { ...JUNE.range, month: '2026-05' },
      availableMonths: ['2026-05', '2026-06'],
    });
    renderPage();
    await screen.findByText('₹8,959.49');

    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
  });

  it('switches the time-series granularity', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    await user.click(screen.getByRole('tab', { name: 'Weekly' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ granularity: 'weekly' }));
  });

  it('drills into a category from the table, scoped to the shown month', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    await user.click(screen.getByRole('button', { name: 'Show HOUSING transactions' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchTransactionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'HOUSING', month: '2026-06' }),
      ),
    );
    expect(await screen.findByText('1 transaction(s) in 2026-06 · ₹2,150.00')).toBeInTheDocument();
  });

  it('drills in from the chart legend too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    await user.click(await screen.findByRole('button', { name: 'bars: SHOPPING' }));

    await waitFor(() =>
      expect(fetchTransactionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'SHOPPING' }),
      ),
    );
  });

  it('carries the range-totals widget, on its own window and the page filter', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('₹8,959.49');

    // Its own question, not a second copy of the tiles above: debits and
    // credits over a window the reader picks.
    expect(screen.getByText('Debits and credits')).toBeInTheDocument();
    expect(await screen.findByText('\u2212₹1,73,967.09')).toHaveClass('text-negative');
    expect(screen.getByText('+₹2,34,010.10')).toHaveClass('text-positive');

    // Narrowing the page to one account narrows the widget with it: that is a
    // filter on whose money, not on which window.
    await user.click(screen.getByRole('combobox', { name: /account/i }));
    await user.click(await screen.findByRole('option', { name: 'Everyday Checking' }));

    await waitFor(() =>
      expect(fetchTotalsMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acct_1' }),
      ),
    );
  });

  it('leads with the savings rate and the fixed commitments', async () => {
    renderPage();
    await screen.findByText('₹8,959.49');

    expect(await screen.findByText('Savings rate')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('BAJAJ FINANCE EMI')).toBeInTheDocument();
    expect(screen.getByText('ZERODHA COIN SIP')).toBeInTheDocument();
  });

  it('puts the predicted bills in the insights panel', async () => {
    renderPage();
    await screen.findByText('₹8,959.49');

    expect(await screen.findByText('Expected next')).toBeInTheDocument();
    expect(screen.getByText(/expected 2026-07-05/)).toBeInTheDocument();
  });

  it('asks for the month the dashboard actually resolved', async () => {
    renderPage();
    await waitFor(() =>
      expect(fetchIndiaMock).toHaveBeenCalledWith(expect.objectContaining({ month: '2026-06' })),
    );
  });

  it('still renders the dashboard when the India pass fails', async () => {
    // A separate query on purpose: the page is useful without it.
    fetchIndiaMock.mockRejectedValue(new Error('nope'));
    renderPage();

    expect(await screen.findByText('₹8,959.49')).toBeInTheDocument();
    expect(screen.queryByText('Savings rate')).not.toBeInTheDocument();
  });

  it('surfaces a failure to load', async () => {
    fetchDashboardMock.mockRejectedValue({ response: { data: { error: 'Database is down' } } });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down');
  });
});
