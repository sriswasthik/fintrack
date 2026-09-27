import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewPage } from '@/pages/ReviewPage';
import {
  fetchReviewQueue,
  overrideCategory,
  type ReviewQueue,
  type Transaction,
} from '@/lib/transactions';

vi.mock('@/lib/transactions', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), fetchReviewQueue: vi.fn(), overrideCategory: vi.fn() };
});

const fetchReviewQueueMock = vi.mocked(fetchReviewQueue);
const overrideCategoryMock = vi.mocked(overrideCategory);

function transaction(overrides: Partial<Transaction> & { id: string }): Transaction {
  return {
    accountId: 'acct_1',
    date: '2026-05-02',
    postedDate: null,
    description: 'TST* THE HALL - DOWNTOWN',
    rawMerchant: 'TST* THE HALL - DOWNTOWN',
    normalizedMerchant: 'THE HALL',
    amount: 42.5,
    currency: 'INR',
    category: 'UNCATEGORIZED',
    confidence: 0,
    source: 'RULE',
    transferPairId: null,
    linkedRefundId: null,
    splits: [],
    ...overrides,
  };
}

const SUGGESTED = transaction({
  id: 'txn_suggested',
  normalizedMerchant: 'BLUEBIRD BAKERY',
  description: 'SQ *BLUEBIRD BAKERY',
  category: 'DINING',
  confidence: 0.42,
  source: 'LLM',
});

const UNRESOLVED = transaction({ id: 'txn_unresolved' });

function queue(transactions: Transaction[]): ReviewQueue {
  return {
    total: transactions.length,
    limit: 100,
    offset: 0,
    counts: {
      uncategorized: transactions.filter((t) => t.category === 'UNCATEGORIZED').length,
      lowConfidence: transactions.filter((t) => t.source === 'LLM' && t.confidence < 0.6).length,
    },
    lowConfidenceThreshold: 0.6,
    transactions,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page links to the learned-rules page, so it needs a router.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return render(<ReviewPage />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchReviewQueueMock.mockResolvedValue(queue([SUGGESTED, UNRESOLVED]));
  overrideCategoryMock.mockResolvedValue({
    transaction: { ...SUGGESTED, category: 'DINING', source: 'MANUAL', confidence: 1 },
    learnedRule: { id: 'rule_1', pattern: '^BLUEBIRD BAKERY$', category: 'DINING' },
  });
});

describe('ReviewPage', () => {
  it('summarizes what is waiting and why', async () => {
    renderPage();

    expect(await screen.findByText('2 to review')).toBeInTheDocument();
    expect(
      screen.getByText('1 uncategorized, 1 AI-suggested below 0.6 confidence.'),
    ).toBeInTheDocument();
  });

  it('shows the AI suggestion with its confidence', async () => {
    renderPage();

    expect(await screen.findByText('BLUEBIRD BAKERY')).toBeInTheDocument();
    expect(screen.getByText('42% confident')).toBeInTheDocument();
  });

  it('marks a row with nothing to suggest', async () => {
    renderPage();

    expect(await screen.findByText('no suggestion')).toBeInTheDocument();
  });

  it('offers one-click accept only where there is a suggestion', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: /Accept DINING/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Accept/ })).toHaveLength(1);
  });

  it('accepts the suggestion in one click', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Accept DINING/ }));

    await waitFor(() => expect(overrideCategoryMock).toHaveBeenCalledTimes(1));
    expect(overrideCategoryMock.mock.calls[0][0]).toEqual({
      transactionId: 'txn_suggested',
      category: 'DINING',
    });
  });

  it('reports the rule the override taught', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Accept DINING/ }));

    expect(await screen.findByText('Learned: ^BLUEBIRD BAKERY$ → DINING')).toBeInTheDocument();
  });

  it('overrides to a different category from the dropdown', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Category for THE HALL'));
    await user.click(await screen.findByRole('option', { name: 'GROCERIES' }));
    await user.click(screen.getByRole('button', { name: 'Save category for THE HALL' }));

    await waitFor(() => expect(overrideCategoryMock).toHaveBeenCalledTimes(1));
    expect(overrideCategoryMock.mock.calls[0][0]).toEqual({
      transactionId: 'txn_unresolved',
      category: 'GROCERIES',
    });
  });

  it('will not save UNCATEGORIZED, which decides nothing', async () => {
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Save category for THE HALL' }),
    ).toBeDisabled();
  });

  it('says so when the queue is empty', async () => {
    fetchReviewQueueMock.mockResolvedValue(queue([]));
    renderPage();

    expect(
      await screen.findByText('Nothing to review — every transaction has a confident category.'),
    ).toBeInTheDocument();
  });

  it('surfaces a failure to load the queue', async () => {
    fetchReviewQueueMock.mockRejectedValue({ response: { data: { error: 'Database is down' } } });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down');
  });

  it('surfaces a failure to save a decision', async () => {
    overrideCategoryMock.mockRejectedValue({
      response: { data: { error: 'No such transaction' } },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Accept DINING/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No such transaction');
  });
});
