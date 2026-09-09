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
  signIn: vi.fn(),
  signUp: vi.fn(),
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
