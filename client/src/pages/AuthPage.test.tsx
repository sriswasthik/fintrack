import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage, RegisterPage } from '@/pages/AuthPage';
import { useAuth } from '@/context/auth-context';
import { GoogleScriptContext, type GoogleScriptState } from '@/context/google-auth';

vi.mock('@/context/auth-context', () => ({ useAuth: vi.fn() }));
// Google's widget loads a remote script and renders an iframe; jsdom can do
// neither. Replaced with a plain button that calls the same onSuccess prop.
vi.mock('@react-oauth/google', () => ({
  GoogleLogin: (props: { text: string; onSuccess: (r: { credential?: string }) => void }) => (
    <button type="button" onClick={() => props.onSuccess({ credential: 'an-id-token' })}>
      Google {props.text}
    </button>
  ),
}));
// The demo button asks /api/health whether a demo is on offer. These tests are
// about the credentials form, so it is told there is none and renders nothing.
vi.mock('@/lib/health', () => ({ fetchHealth: vi.fn().mockResolvedValue({ status: 'ok' }) }));
const useAuthMock = vi.mocked(useAuth);

const signIn = vi.fn();
const signUp = vi.fn();
const signInWithGoogle = vi.fn();

const session = (over: Partial<ReturnType<typeof useAuth>> = {}) => ({
  user: null,
  isRestoring: false,
  isDemo: false,
  signIn,
  signUp,
  signInWithGoogle,
  startDemo: vi.fn(),
  signOut: vi.fn(),
  ...over,
});

function renderAuth(
  page: 'login' | 'register',
  entry = `/${page}`,
  state: unknown = undefined,
  script: GoogleScriptState = 'ready',
) {
  // The real app renders these inside a QueryClientProvider; the demo button
  // asks the server whether a demo is on offer.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <GoogleScriptContext.Provider value={script}>
        <MemoryRouter initialEntries={[{ pathname: entry, state }]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/dashboard" element={<p>the dashboard</p>} />
            <Route path="/summary" element={<p>the summary</p>} />
          </Routes>
        </MemoryRouter>
      </GoogleScriptContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn.mockResolvedValue(undefined);
  signUp.mockResolvedValue(undefined);
  signInWithGoogle.mockResolvedValue({ isNewUser: false });
  useAuthMock.mockReturnValue(session());
});

describe('sign in', () => {
  it('sends the credentials and lands on the dashboard', async () => {
    const user = userEvent.setup();
    renderAuth('login');

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(signIn).toHaveBeenCalledWith({
      email: 'alice@example.test',
      password: 'correct-horse-battery',
    });
    expect(await screen.findByText('the dashboard')).toBeInTheDocument();
  });

  it('shows what the server said when it refuses', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValue({ response: { data: { error: 'Incorrect email or password' } } });
    renderAuth('login');

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
    // Still on the form, with what they typed intact.
    expect(screen.getByLabelText('Email')).toHaveValue('alice@example.test');
  });

  it('says so when the server cannot be reached at all', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    renderAuth('login');

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
  });

  it('disables the button while the request is in flight', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    signIn.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    renderAuth('login');

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();
    release();
  });

  it('does not ask a signed-in person to sign in again', () => {
    useAuthMock.mockReturnValue(
      session({ user: { id: 'user_1', email: 'alice@example.test', name: null } }),
    );
    renderAuth('login');

    expect(screen.getByText('the dashboard')).toBeInTheDocument();
  });

  it('waits for the session to restore before deciding', () => {
    useAuthMock.mockReturnValue(session({ isRestoring: true }));
    renderAuth('login');

    expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
});

describe('register', () => {
  it('creates the account, with the optional name when given', async () => {
    const user = userEvent.setup();
    renderAuth('register');

    await user.type(screen.getByLabelText('Name'), 'Alice');
    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(signUp).toHaveBeenCalledWith({
      email: 'alice@example.test',
      password: 'correct-horse-battery',
      name: 'Alice',
    });
  });

  it('leaves the name out entirely rather than sending an empty one', async () => {
    const user = userEvent.setup();
    renderAuth('register');

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(signUp).toHaveBeenCalledWith({
      email: 'alice@example.test',
      password: 'correct-horse-battery',
    });
  });

  it('states the password rule up front rather than after a rejection', () => {
    renderAuth('register');
    expect(screen.getByText(/at least 10 characters/i)).toBeInTheDocument();
  });

  it('surfaces the server refusing the address', async () => {
    const user = userEvent.setup();
    signUp.mockRejectedValue({
      response: { data: { error: 'That email address cannot be registered' } },
    });
    renderAuth('register');

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be registered');
  });

  it('offers the way back to signing in', () => {
    renderAuth('register');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});

describe('the destination carried in router state', () => {
  it('continues to where the person was actually headed', async () => {
    const user = userEvent.setup();
    renderAuth('login', '/login', { from: '/summary?month=2026-04' });

    await user.type(screen.getByLabelText('Email'), 'alice@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('the summary')).toBeInTheDocument();
  });

  it('will not be talked into leaving the app', async () => {
    // Router state is reachable by anything that can push history at us, and
    // react-router 6 follows a protocol-relative path off-origin
    // (GHSA-wrjc-x8rr-h8h6). safeRedirect sends it to the dashboard instead.
    useAuthMock.mockReturnValue(
      session({ user: { id: 'user_1', email: 'alice@example.test', name: null } }),
    );
    renderAuth('login', '/login', { from: '//evil.test' });

    expect(await screen.findByText('the dashboard')).toBeInTheDocument();
  });
});

describe('Google sign-in', () => {
  it.each([
    ['login', 'signin_with'],
    ['register', 'signup_with'],
  ] as const)('offers the Google button on the %s page', (page, label) => {
    // Both pages, per the brief — somebody creating an account and somebody
    // coming back should each get the one-click path.
    renderAuth(page);
    expect(screen.getByRole('button', { name: `Google ${label}` })).toBeInTheDocument();
  });

  it('signs in through the context and lands on the destination', async () => {
    const user = userEvent.setup();
    renderAuth('login');

    await user.click(screen.getByRole('button', { name: 'Google signin_with' }));

    expect(signInWithGoogle).toHaveBeenCalledWith('an-id-token');
    expect(await screen.findByText('the dashboard')).toBeInTheDocument();
  });

  it('honours where the visitor was headed before being sent to sign in', async () => {
    const user = userEvent.setup();
    renderAuth('login', '/login', { from: '/summary' });

    await user.click(screen.getByRole('button', { name: 'Google signin_with' }));

    expect(await screen.findByText('the summary')).toBeInTheDocument();
  });

  it('still offers the password form alongside it', () => {
    // The brief is explicit that the existing flow is not removed.
    renderAuth('login');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it.each(['disabled', 'unavailable'] as const)(
    'hides the button and its divider when Google is %s',
    (script) => {
      renderAuth('login', '/login', undefined, script);

      expect(screen.queryByRole('button', { name: /^Google / })).not.toBeInTheDocument();
      // The "or" belongs to the button; without one it separates the form from
      // nothing.
      expect(screen.queryByText('or')).not.toBeInTheDocument();
      // And the password form is untouched — the existing flow never depended
      // on Google being reachable.
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    },
  );

  it('shows the divider when the button is there', () => {
    renderAuth('login');
    expect(screen.getByText('or')).toBeInTheDocument();
  });
});
