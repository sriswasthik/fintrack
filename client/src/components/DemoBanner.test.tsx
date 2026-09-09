import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoBanner } from '@/components/DemoBanner';
import { useAuth } from '@/context/auth-context';

vi.mock('@/context/auth-context', () => ({ useAuth: vi.fn() }));

const useAuthMock = vi.mocked(useAuth);
const signOut = vi.fn();

const session = (isDemo: boolean) => ({
  user: { id: 'user_demo', email: 'demo@fintrack.local', name: 'Demo User' },
  isRestoring: false,
  isDemo,
  signIn: vi.fn(),
  signUp: vi.fn(),
  startDemo: vi.fn(),
  signOut,
});

const renderBanner = () =>
  render(
    <MemoryRouter>
      <DemoBanner />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  signOut.mockResolvedValue(undefined);
});

describe('DemoBanner', () => {
  it('tells a visitor the account is not theirs and is read-only', () => {
    useAuthMock.mockReturnValue(session(true));
    renderBanner();

    expect(screen.getByText(/read-only sample account/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /create your own/i })).toHaveAttribute(
      'href',
      '/register',
    );
  });

  it('leaves the demo when asked', async () => {
    useAuthMock.mockReturnValue(session(true));
    const user = userEvent.setup();
    renderBanner();

    await user.click(screen.getByRole('button', { name: /leave demo/i }));

    expect(signOut).toHaveBeenCalledOnce();
  });

  it('renders nothing at all for a real session', () => {
    useAuthMock.mockReturnValue(session(false));
    const { container } = renderBanner();

    expect(container).toBeEmptyDOMElement();
  });
});
