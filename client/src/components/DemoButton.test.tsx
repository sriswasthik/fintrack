import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoButton } from '@/components/DemoButton';
import { useAuth } from '@/context/auth-context';
import { fetchHealth } from '@/lib/health';

vi.mock('@/context/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/health', () => ({ fetchHealth: vi.fn() }));

const useAuthMock = vi.mocked(useAuth);
const fetchHealthMock = vi.mocked(fetchHealth);
const startDemo = vi.fn();

function renderButton() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DemoButton />} />
          <Route path="/dashboard" element={<p>the dashboard</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const label = /see it with sample data/i;

beforeEach(() => {
  vi.clearAllMocks();
  startDemo.mockResolvedValue(undefined);
  fetchHealthMock.mockResolvedValue({ status: 'ok', demo: true });
  useAuthMock.mockReturnValue({
    user: null,
    isRestoring: false,
    isDemo: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    startDemo,
    signOut: vi.fn(),
  });
});

describe('DemoButton', () => {
  it('takes a visitor straight to the dashboard', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(await screen.findByRole('button', { name: label }));

    expect(startDemo).toHaveBeenCalledOnce();
    expect(await screen.findByText('the dashboard')).toBeInTheDocument();
  });

  it('stays hidden on a deployment that does not offer a demo', async () => {
    // A private instance holding somebody's real statements must never invite
    // a stranger in, so the button follows the server's flag rather than a
    // build-time constant.
    fetchHealthMock.mockResolvedValue({ status: 'ok', demo: false });
    renderButton();

    await waitFor(() => expect(fetchHealthMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it('stays hidden when the API cannot be reached at all', async () => {
    fetchHealthMock.mockRejectedValue(new Error('Network Error'));
    renderButton();

    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });

  it('says so when the demo is advertised but broken', async () => {
    startDemo.mockRejectedValue({
      response: { data: { error: 'The demo dataset has not been seeded on this server' } },
    });
    const user = userEvent.setup();
    renderButton();

    await user.click(await screen.findByRole('button', { name: label }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not been seeded/i);
  });
});
