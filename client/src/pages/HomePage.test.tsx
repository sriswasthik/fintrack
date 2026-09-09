import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from '@/pages/HomePage';
import { useAuth } from '@/context/auth-context';
import { fetchHealth } from '@/lib/health';

vi.mock('@/lib/health', () => ({ fetchHealth: vi.fn() }));
vi.mock('@/context/auth-context', () => ({ useAuth: vi.fn() }));

const fetchHealthMock = vi.mocked(fetchHealth);
const useAuthMock = vi.mocked(useAuth);

const session = (over: Partial<ReturnType<typeof useAuth>> = {}) => ({
  user: null,
  isRestoring: false,
  isDemo: false,
  signIn: vi.fn(),
  signUp: vi.fn(),
  startDemo: vi.fn(),
  signOut: vi.fn(),
  ...over,
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchHealthMock.mockResolvedValue({ status: 'ok' });
  useAuthMock.mockReturnValue(session());
});

describe('HomePage', () => {
  it('invites a visitor with no account to make one', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: 'Create an account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dashboard/i })).not.toBeInTheDocument();
  });

  it('points a signed-in person at their own month instead', async () => {
    useAuthMock.mockReturnValue(
      session({ user: { id: 'user_1', email: 'alice@example.test', name: 'Alice' } }),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: 'Open your dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
  });

  it('waits rather than guessing while the session is being restored', () => {
    useAuthMock.mockReturnValue(session({ isRestoring: true }));
    renderPage();

    expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
  });

  it('renders the status returned by GET /api/health', async () => {
    renderPage();

    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByText('Reachable.')).toBeInTheDocument();
    expect(fetchHealthMock).toHaveBeenCalledOnce();
  });

  it('says so when the API cannot be reached', async () => {
    fetchHealthMock.mockRejectedValue(new Error('Network Error'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });
});
