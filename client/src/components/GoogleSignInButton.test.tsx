import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { useAuth } from '@/context/auth-context';
import { GoogleScriptContext, type GoogleScriptState } from '@/context/google-auth';

vi.mock('@/context/auth-context', () => ({ useAuth: vi.fn() }));

/**
 * Google's button, stubbed.
 *
 * The real one loads a script from accounts.google.com and renders an iframe;
 * jsdom can do neither. What is replaced is Google's widget, not our handling
 * of what it hands back — the stub calls the same `onSuccess`/`onError` props
 * the real component does.
 */
const googleLogin = vi.fn();
vi.mock('@react-oauth/google', () => ({
  GoogleLogin: (props: {
    text: string;
    onSuccess: (r: { credential?: string }) => void;
    onError: () => void;
  }) => {
    googleLogin(props);
    return (
      <div>
        <button type="button" onClick={() => props.onSuccess({ credential: 'an-id-token' })}>
          Google: {props.text}
        </button>
        <button type="button" onClick={() => props.onSuccess({})}>
          Google: no credential
        </button>
        <button type="button" onClick={() => props.onError()}>
          Google: fails
        </button>
      </div>
    );
  },
}));

const useAuthMock = vi.mocked(useAuth);
const signInWithGoogle = vi.fn();
const onSignedIn = vi.fn();

/** Renders the button with Google's script in a given state. */
function renderButton(
  props: { label?: 'signin_with' | 'signup_with' } = {},
  script: GoogleScriptState = 'ready',
) {
  return render(
    <GoogleScriptContext.Provider value={script}>
      <GoogleSignInButton label={props.label ?? 'signin_with'} onSignedIn={onSignedIn} />
    </GoogleScriptContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signInWithGoogle.mockResolvedValue({ isNewUser: false });
  useAuthMock.mockReturnValue({
    user: null,
    isRestoring: false,
    isDemo: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle,
    startDemo: vi.fn(),
    signOut: vi.fn(),
  });
});

describe('GoogleSignInButton', () => {
  it('renders nothing when the build has no Google client id', () => {
    // A deployment that has not configured Google should show no button rather
    // than one that fails when pressed.
    const { container } = renderButton({}, 'disabled');

    expect(container).toBeEmptyDOMElement();
    expect(googleLogin).not.toHaveBeenCalled();
  });

  it('renders nothing when Google’s script could not load', () => {
    // A blocked network or an outage. Reserving space for a button that will
    // never appear reads as broken; showing nothing reads as unavailable.
    const { container } = renderButton({}, 'unavailable');

    expect(container).toBeEmptyDOMElement();
    expect(googleLogin).not.toHaveBeenCalled();
  });

  it('renders while the script is still loading', () => {
    // Google's own component reserves its space; taking the button away and
    // putting it back would be a worse flicker than waiting.
    renderButton({}, 'pending');
    expect(googleLogin).toHaveBeenCalled();
  });

  it.each(['signin_with', 'signup_with'] as const)('asks Google for %s wording', (label) => {
    renderButton({ label });
    expect(googleLogin).toHaveBeenCalledWith(expect.objectContaining({ text: label }));
  });

  it('sends the credential to the server and then continues', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /Google: signin_with/ }));

    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledWith('an-id-token'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it('does not navigate when the sign-in is rejected', async () => {
    signInWithGoogle.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /Google: signin_with/ }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('says so when Google hands back no credential', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /Google: no credential/ }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(signInWithGoogle).not.toHaveBeenCalled();
  });

  it('reports a failure inside Google’s own flow', async () => {
    // Popup blocked, closed, refused. Google's hook carries no detail, so
    // neither does the message.
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /Google: fails/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not work/i);
    expect(signInWithGoogle).not.toHaveBeenCalled();
  });

  it('clears an earlier error when a later attempt succeeds', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /Google: fails/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Google: signin_with/ }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
