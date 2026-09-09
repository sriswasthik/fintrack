import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/context/AuthContext';
import { useAuth } from '@/context/auth-context';
import type * as AuthModule from '@/lib/auth';
import { refreshSession, startDemo, type Session } from '@/lib/auth';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, refreshSession: vi.fn(), startDemo: vi.fn(), logout: vi.fn() };
});

const refreshSessionMock = vi.mocked(refreshSession);
const startDemoMock = vi.mocked(startDemo);

const demoSession: Session = {
  accessToken: 'demo-token',
  expiresIn: 7200,
  user: { id: 'user_demo', email: 'demo@fintrack.local', name: 'Demo User' },
  demo: true,
};

function Probe() {
  const { user, isDemo, isRestoring, startDemo: enter, signOut } = useAuth();
  if (isRestoring) return <p>restoring</p>;
  return (
    <div>
      <p>{user ? `${user.email} demo=${String(isDemo)}` : 'signed out'}</p>
      <button onClick={() => void enter()}>enter demo</button>
      <button onClick={() => void signOut()}>leave</button>
    </div>
  );
}

const renderApp = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // Nobody is signed in: no refresh cookie to exchange.
  refreshSessionMock.mockRejectedValue(new Error('401'));
  startDemoMock.mockResolvedValue(demoSession);
});

describe('a demo session', () => {
  it('starts without any credentials', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: 'enter demo' }));

    expect(await screen.findByText('demo@fintrack.local demo=true')).toBeInTheDocument();
  });

  it('survives a reload, having no refresh cookie to be restored from', async () => {
    // The bug this covers: a demo visitor who pressed reload was dropped at the
    // login page, because restoring a session means presenting a refresh cookie
    // and a demo was deliberately never given one.
    const user = userEvent.setup();
    const first = renderApp();
    await user.click(await screen.findByRole('button', { name: 'enter demo' }));
    await screen.findByText('demo@fintrack.local demo=true');
    first.unmount();

    renderApp(); // a fresh page load, same tab

    expect(await screen.findByText('demo@fintrack.local demo=true')).toBeInTheDocument();
    expect(startDemoMock).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect itself once the visitor has left', async () => {
    const user = userEvent.setup();
    const first = renderApp();
    await user.click(await screen.findByRole('button', { name: 'enter demo' }));
    await screen.findByText('demo@fintrack.local demo=true');
    await user.click(screen.getByRole('button', { name: 'leave' }));
    await screen.findByText('signed out');
    first.unmount();

    renderApp();

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(startDemoMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a visitor signed out when the demo has been turned off', async () => {
    sessionStorage.setItem('fintrack.demo', '1');
    startDemoMock.mockRejectedValue(new Error('404'));

    renderApp();

    expect(await screen.findByText('signed out')).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('fintrack.demo')).toBeNull());
  });

  it('leaves a real session alone', async () => {
    refreshSessionMock.mockResolvedValue({
      accessToken: 'real-token',
      expiresIn: 900,
      user: { id: 'user_1', email: 'alice@example.test', name: 'Alice' },
    });

    renderApp();

    expect(await screen.findByText('alice@example.test demo=false')).toBeInTheDocument();
    expect(startDemoMock).not.toHaveBeenCalled();
  });
});
