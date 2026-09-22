import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import { dismissInsight, fetchInsights, type Insight } from '@/lib/insights';

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

vi.mock('@/lib/insights', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), fetchInsights: vi.fn(), dismissInsight: vi.fn() };
});

const fetchInsightsMock = vi.mocked(fetchInsights);
const dismissInsightMock = vi.mocked(dismissInsight);

const SPIKE: Insight = {
  id: 'flag_spike',
  type: 'CATEGORY_SPEND_SPIKE',
  severity: 'HIGH',
  month: '2026-05',
  explanation:
    'SHOPPING came to ₹4,917.40 this month, 262% above the ₹1,358.53 typical of the previous 2 months (₹3,558.87 more than usual).',
  transactionId: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  transaction: null,
};

const LAPTOP: Insight = {
  id: 'flag_laptop',
  type: 'UNUSUAL_AMOUNT',
  severity: 'MEDIUM',
  month: '2026-05',
  explanation: '₹3,299.00 at CROMA RETAIL is unusually large for SHOPPING.',
  transactionId: 'txn_1',
  createdAt: '2026-09-08T00:00:00.000Z',
  transaction: {
    id: 'txn_1',
    date: '2026-05-16',
    description: 'CROMA RETAIL #R412',
    merchant: 'CROMA RETAIL',
    amount: 3299,
    category: 'SHOPPING',
  },
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <InsightsPanel month="2026-05" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchInsightsMock.mockResolvedValue({ month: '2026-05', insights: [SPIKE, LAPTOP], detected: 2 });
  dismissInsightMock.mockResolvedValue();
});

describe('InsightsPanel', () => {
  it('renders each flag with a plain-language type and its explanation', async () => {
    renderPanel();

    expect(await screen.findByText('Spending spike')).toBeInTheDocument();
    expect(screen.getByText('Unusual amount')).toBeInTheDocument();
    expect(screen.getByText(SPIKE.explanation)).toBeInTheDocument();
    expect(screen.getByText(LAPTOP.explanation)).toBeInTheDocument();
    expect(screen.getByText('2 things stood out this month')).toBeInTheDocument();
  });

  it('shows the transaction behind a flag that has one', async () => {
    renderPanel();
    expect(
      await screen.findByText('2026-05-16 · CROMA RETAIL #R412 · ₹3,299.00'),
    ).toBeInTheDocument();
  });

  it('names the severity rather than leaving it to colour alone', async () => {
    renderPanel();
    expect(await screen.findByText('High')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
  });

  it('asks the server for the month it was given', async () => {
    renderPanel();
    await waitFor(() => expect(fetchInsightsMock).toHaveBeenCalledWith({ month: '2026-05' }));
  });

  it('removes a dismissed insight straight away, without waiting on the network', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    dismissInsightMock.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    renderPanel();
    await user.click(await screen.findByRole('button', { name: `Dismiss: ${SPIKE.explanation}` }));

    expect(screen.queryByText(SPIKE.explanation)).not.toBeInTheDocument();
    expect(screen.getByText(LAPTOP.explanation)).toBeInTheDocument();
    // React Query v5 hands the mutation context along as a second argument.
    expect(dismissInsightMock).toHaveBeenCalledWith('flag_spike', expect.anything());

    release?.();
  });

  it('puts the insight back and says so when dismissing fails', async () => {
    const user = userEvent.setup();
    dismissInsightMock.mockRejectedValue(new Error('offline'));

    renderPanel();
    await user.click(await screen.findByRole('button', { name: `Dismiss: ${SPIKE.explanation}` }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be dismissed');
    expect(screen.getByText(SPIKE.explanation)).toBeInTheDocument();
  });

  it('says nothing stood out rather than showing an empty list', async () => {
    fetchInsightsMock.mockResolvedValue({ month: '2026-05', insights: [], detected: 0 });
    renderPanel();

    expect(await screen.findByText('Nothing unusual this month.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
  });

  it('accounts for flags the user has already dismissed', async () => {
    fetchInsightsMock.mockResolvedValue({ month: '2026-05', insights: [LAPTOP], detected: 3 });
    renderPanel();

    expect(await screen.findByText('2 dismissed insights hidden.')).toBeInTheDocument();
  });

  it('uses the singular for one finding', async () => {
    fetchInsightsMock.mockResolvedValue({ month: '2026-05', insights: [LAPTOP], detected: 1 });
    renderPanel();

    expect(await screen.findByText('1 thing stood out this month')).toBeInTheDocument();
  });
});
