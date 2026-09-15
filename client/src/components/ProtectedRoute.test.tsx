import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/auth-context';

vi.mock('@/context/auth-context', () => ({ useAuth: vi.fn() }));
const useAuthMock = vi.mocked(useAuth);

const session = (over: Partial<ReturnType<typeof useAuth>> = {}) => ({
  user: null,
  isRestoring: false,
  isDemo: false,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signInWithGoogle: vi.fn(),
  startDemo: vi.fn(),
  signOut: vi.fn(),
  ...over,
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <p>the dashboard</p>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<p>the login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue(session());
});

describe('ProtectedRoute', () => {
  it('renders the page for a signed-in user', () => {
    useAuthMock.mockReturnValue(
      session({ user: { id: 'user_1', email: 'alice@example.test', name: null } }),
    );
    renderAt('/dashboard');

    expect(screen.getByText('the dashboard')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to the login page', () => {
    renderAt('/dashboard');

    expect(screen.getByText('the login page')).toBeInTheDocument();
    expect(screen.queryByText('the dashboard')).not.toBeInTheDocument();
  });

  it('waits while the session is being restored rather than bouncing a reload', () => {
    // On a reload the app has a refresh cookie but no access token yet.
    // Redirecting before that exchange settles would sign the user out every
    // time they pressed refresh.
    useAuthMock.mockReturnValue(session({ isRestoring: true }));
    renderAt('/dashboard');

    expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    expect(screen.queryByText('the login page')).not.toBeInTheDocument();
    expect(screen.queryByText('the dashboard')).not.toBeInTheDocument();
  });
});

describe('a write-only page during a demo', () => {
  it('explains why rather than showing a form that cannot be submitted', () => {
    useAuthMock.mockReturnValue(
      session({ user: { id: 'user_demo', email: 'demo@fintrack.local', name: null }, isDemo: true }),
    );

    render(
      <MemoryRouter initialEntries={['/upload']}>
        <Routes>
          <Route
            path="/upload"
            element={
              <ProtectedRoute writes>
                <p>the import form</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/not part of the demo/i)).toBeInTheDocument();
    expect(screen.queryByText('the import form')).not.toBeInTheDocument();
  });

  it('leaves the same page alone for a real session', () => {
    useAuthMock.mockReturnValue(
      session({ user: { id: 'user_1', email: 'alice@example.test', name: 'Alice' } }),
    );

    render(
      <MemoryRouter initialEntries={['/upload']}>
        <Routes>
          <Route
            path="/upload"
            element={
              <ProtectedRoute writes>
                <p>the import form</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('the import form')).toBeInTheDocument();
  });
});
