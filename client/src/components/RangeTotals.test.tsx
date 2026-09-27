import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RangeTotals } from '@/components/RangeTotals';
import { fetchTotals, type RangeTotals as Totals, type TotalsParams } from '@/lib/totals';

vi.mock('@/lib/totals', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchTotals: vi.fn(),
}));

const fetchTotalsMock = vi.mocked(fetchTotals);

const MINUS = '−';

/** A fixed "now", so "Today" and "This Quarter" are not a moving target. */
const NOW = new Date(2026, 8, 17, 10, 30); // 17 September 2026, local time

const answer = (over: Partial<Totals> = {}): Totals => ({
  range: { kind: 'monthly', startDate: '2026-09-01', endDate: '2026-09-30', month: '2026-09' },
  filters: { accountId: null },
  totalDebits: 8499.53,
  totalCredits: 4599,
  net: 3900.53,
  transactionCount: 8,
  ...over,
});

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The params of the most recent request. */
const lastParams = (): TotalsParams =>
  fetchTotalsMock.mock.calls[fetchTotalsMock.mock.calls.length - 1][0];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  fetchTotalsMock.mockReset();
  fetchTotalsMock.mockResolvedValue(answer());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the three figures', () => {
  it('shows debits red, credits green and net by its own sign', async () => {
    mount(<RangeTotals />);

    const debits = await screen.findByText(`${MINUS}₹8,499.53`);
    expect(debits).toHaveClass('text-negative');

    const credits = screen.getByText('+₹4,599.00');
    expect(credits).toHaveClass('text-positive');

    // Net is debit-positive like every stored amount, so a positive net is
    // money gone and reads red without anybody having to say so.
    const net = screen.getByText(`${MINUS}₹3,900.53`);
    expect(net).toHaveClass('text-negative');
  });

  it('turns net green when more arrived than left', async () => {
    fetchTotalsMock.mockResolvedValue(
      answer({ totalDebits: 173967.09, totalCredits: 234010.1, net: -60043.01 }),
    );
    mount(<RangeTotals />);

    const net = await screen.findByText('+₹60,043.01');
    expect(net).toHaveClass('text-positive');
    expect(screen.getByText('more arrived than left')).toBeInTheDocument();
  });

  it('says so when the range is empty rather than looking broken', async () => {
    fetchTotalsMock.mockResolvedValue(
      answer({ totalDebits: 0, totalCredits: 0, net: 0, transactionCount: 0 }),
    );
    mount(<RangeTotals />);

    expect(await screen.findByText('Nothing in this range.')).toBeInTheDocument();
    // Zero is not a debit and not a credit.
    expect(screen.getAllByText('₹0.00')[0]).not.toHaveClass('text-negative');
  });
});

describe('the quick-select chips', () => {
  it('starts on this month', async () => {
    mount(<RangeTotals />);
    await waitFor(() => expect(fetchTotalsMock).toHaveBeenCalled());
    expect(lastParams()).toEqual({ range: 'monthly', month: '2026-09' });
  });

  it('asks for today as a single day', async () => {
    mount(<RangeTotals />);
    await waitFor(() => expect(fetchTotalsMock).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));

    await waitFor(() => expect(lastParams()).toEqual({ range: 'daily', date: '2026-09-17' }));
  });

  it('asks for the calendar quarter, worked out here rather than server-side', async () => {
    mount(<RangeTotals />);
    await waitFor(() => expect(fetchTotalsMock).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'This Quarter' }));

    await waitFor(() =>
      expect(lastParams()).toEqual({
        range: 'custom',
        startDate: '2026-07-01',
        endDate: '2026-09-30',
      }),
    );
  });

  it('marks the selected chip for assistive technology, not only by colour', async () => {
    mount(<RangeTotals />);
    expect(screen.getByRole('button', { name: 'This Month' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('can be asked to start somewhere else', async () => {
    mount(<RangeTotals defaultPreset="today" />);
    await waitFor(() => expect(lastParams()).toEqual({ range: 'daily', date: '2026-09-17' }));
  });
});

describe('the custom range', () => {
  it('reveals the date fields only when Custom is chosen', async () => {
    mount(<RangeTotals />);
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('sends the dates the reader picked', async () => {
    mount(<RangeTotals />);
    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));

    const from = screen.getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-04-01');
    const to = screen.getByLabelText('To');
    await userEvent.clear(to);
    await userEvent.type(to, '2026-06-30');

    await waitFor(() =>
      expect(lastParams()).toEqual({
        range: 'custom',
        startDate: '2026-04-01',
        endDate: '2026-06-30',
      }),
    );
  });

  it('refuses a backwards range here instead of asking the server', async () => {
    mount(<RangeTotals />);
    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const before = fetchTotalsMock.mock.calls.length;

    const from = screen.getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-12-01');

    expect(await screen.findByText('The end date is before the start date.')).toBeInTheDocument();
    expect(fetchTotalsMock.mock.calls.length).toBe(before);
  });
});

describe('as a standalone component', () => {
  it('passes an account filter through when it is given one', async () => {
    mount(<RangeTotals accountId="acct_1" />);
    await waitFor(() =>
      expect(lastParams()).toEqual({ range: 'monthly', month: '2026-09', accountId: 'acct_1' }),
    );
  });

  it('sends no account filter when it has none', async () => {
    mount(<RangeTotals />);
    await waitFor(() => expect(lastParams()).not.toHaveProperty('accountId'));
  });

  it('takes its own heading', async () => {
    mount(<RangeTotals title="Debits and credits" />);
    expect(screen.getByText('Debits and credits')).toBeInTheDocument();
  });

  it('surfaces a failure instead of showing stale zeros as fact', async () => {
    // The server's own wording, which is written for a reader: "startDate and
    // endDate are required when range=custom" beats anything generic.
    fetchTotalsMock.mockRejectedValue({
      response: { data: { error: 'No account with id "acct_9"' } },
    });
    mount(<RangeTotals />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No account with id "acct_9"');
  });

  it('falls back to its own wording when the failure carries none', async () => {
    fetchTotalsMock.mockRejectedValue('something opaque');
    mount(<RangeTotals />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add up that range.');
  });
});
