import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SummaryPage } from '@/pages/SummaryPage';
import { fetchSummary, regenerateSummary, type MonthlySummary } from '@/lib/summary';

// This component adapts to a read-only demo session; these tests are about a
// normal one. (The demo behaviour has its own tests.)
vi.mock('@/context/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'user_1', email: 'alice@example.test', name: 'Alice' },
    isRestoring: false,
    isDemo: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    startDemo: vi.fn(),
    signOut: vi.fn(),
  }),
}));


vi.mock('@/lib/summary', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), fetchSummary: vi.fn(), regenerateSummary: vi.fn() };
});

const fetchSummaryMock = vi.mocked(fetchSummary);
const regenerateSummaryMock = vi.mocked(regenerateSummary);

const JUNE: MonthlySummary = {
  month: '2026-06',
  content:
    'June was a calmer month. You spent ₹8,959.49 against income of ₹10,926.72, a savings rate of 18%.',
  source: 'model',
  cached: true,
  stale: false,
  generatedAt: '2026-09-08T00:00:00.000Z',
  stats: {
    month: '2026-06',
    monthLabel: 'June 2026',
    previousMonth: '2026-05',
    previousMonthLabel: 'May 2026',
    spend: 8959.49,
    income: 10926.72,
    net: 1967.23,
    transactions: 111,
    previousSpend: 13295.66,
    previousIncome: 8225.77,
    spendChange: -32.6,
    incomeChange: 32.8,
    savingsRate: 18,
    topCategories: [
      { category: 'HOUSING', amount: 2150, previousAmount: 2150, change: 0, share: 24 },
      { category: 'SHOPPING', amount: 1945.84, previousAmount: 4917.4, change: -60.4, share: 21.7 },
    ],
    topMerchant: { merchant: 'OAKWOOD PROPERTY MGMT', amount: 2150, transactions: 1 },
    anomalies: [],
  },
};

function renderPage(search = '?month=2026-06') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/summary${search}`]}>
        <SummaryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSummaryMock.mockResolvedValue(JUNE);
  regenerateSummaryMock.mockResolvedValue({
    ...JUNE,
    content: 'A fresh look at June: ₹8,959.49 out, ₹10,926.72 in.',
    cached: false,
  });
});

describe('SummaryPage', () => {
  it('shows the recap for the month in the URL', async () => {
    renderPage();

    expect(await screen.findByText(JUNE.content)).toBeInTheDocument();
    await waitFor(() => expect(fetchSummaryMock).toHaveBeenCalledWith({ month: '2026-06' }));
  });

  it('shows the figures the recap was written from, so a reader can check it', async () => {
    renderPage();

    expect(await screen.findByText('₹8,959.49')).toBeInTheDocument();
    expect(screen.getByText('₹10,926.72')).toBeInTheDocument();
    expect(screen.getByText('18%')).toBeInTheDocument();
    expect(screen.getByText('HOUSING')).toBeInTheDocument();
    expect(screen.getByText('-60.4%')).toBeInTheDocument();
    expect(screen.getByText(/OAKWOOD PROPERTY MGMT/)).toBeInTheDocument();
  });

  it('regenerates on demand and shows the new text', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(JUNE.content);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByText(/A fresh look at June/)).toBeInTheDocument();
    expect(regenerateSummaryMock).toHaveBeenCalledWith({ month: '2026-06' });
  });

  it('does not regenerate just by opening the page', async () => {
    renderPage();
    await screen.findByText(JUNE.content);
    expect(regenerateSummaryMock).not.toHaveBeenCalled();
  });

  it('says when the figures have moved out from under the text', async () => {
    fetchSummaryMock.mockResolvedValue({ ...JUNE, stale: true });
    renderPage();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'The figures have changed since this was written',
    );
    // The text is still shown — stale is not the same as wrong.
    expect(screen.getByText(JUNE.content)).toBeInTheDocument();
  });

  it('says when there is no model to write with', async () => {
    fetchSummaryMock.mockResolvedValue({
      ...JUNE,
      source: 'fallback',
      unavailable: 'the summary model is not configured on this server.',
    });
    renderPage();

    expect(await screen.findByRole('status')).toHaveTextContent('not configured on this server');
    expect(screen.getByText(/Computed from 111 transactions/)).toBeInTheDocument();
  });

  it('says when the written recap was rejected for not matching the figures', async () => {
    fetchSummaryMock.mockResolvedValue({ ...JUNE, source: 'fallback' });
    renderPage();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'did not match the computed figures',
    );
  });

  it('steps back a month without reloading the page', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(JUNE.content);

    await user.click(screen.getByRole('button', { name: 'Previous month' }));

    await waitFor(() => expect(fetchSummaryMock).toHaveBeenCalledWith({ month: '2026-05' }));
    // "May 2026" also appears in the comparison columns, so read the header itself.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.parentElement).toHaveTextContent('May 2026');
  });

  it('will not step into a month that has not happened yet', async () => {
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    renderPage();
    await screen.findByText(JUNE.content);

    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
    vi.useRealTimers();
  });

  it('reports a failed regeneration without losing what is on screen', async () => {
    const user = userEvent.setup();
    regenerateSummaryMock.mockRejectedValue(new Error('The model timed out'));
    renderPage();
    await screen.findByText(JUNE.content);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The model timed out');
    expect(screen.getByText(JUNE.content)).toBeInTheDocument();
  });
});
