import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';

import { useAuth } from '@/context/auth-context';
import { useGoogleSignInAvailable } from '@/context/google-auth';
import { authErrorMessage } from '@/lib/auth';

/**
 * "Sign in with Google", rendered by Google itself.
 *
 * `GoogleLogin` draws Google's own button and runs their flow; what comes back
 * is an ID token, which goes straight to the server. Nothing is read out of it
 * here — a token this code parsed would be exactly as trustworthy as the page
 * parsing it, which is not at all.
 *
 * Renders nothing when the build has no `VITE_GOOGLE_CLIENT_ID`, and nothing
 * when Google's script failed to load. A deployment that has not configured
 * Google — or a visitor whose network blocks google.com — should see no button
 * rather than one that cannot work.
 */
export function GoogleSignInButton({
  onSignedIn,
  label,
}: {
  /** Called after the session is established, so the page can navigate. */
  onSignedIn: () => void;
  /** Google renders "signin_with" or "signup_with" wording from this. */
  label: 'signin_with' | 'signup_with';
}) {
  const { signInWithGoogle } = useAuth();
  const available = useGoogleSignInAvailable();
  const [error, setError] = useState<string | null>(null);

  if (!available) return null;

  return (
    <div className="space-y-2">
      <div className="flex justify-center">
        <GoogleLogin
          text={label}
          width="320"
          onSuccess={(response) => {
            setError(null);
            const credential = response.credential;
            if (!credential) {
              setError('Google did not return a sign-in token. Try again.');
              return;
            }
            void signInWithGoogle(credential)
              .then(onSignedIn)
              .catch((caught: unknown) => {
                setError(authErrorMessage(caught, 'That Google sign-in did not work. Try again.'));
              });
          }}
          onError={() => {
            // Google's own failure hook: popup blocked, closed, or refused.
            // It gives no detail, so neither can we.
            setError('That Google sign-in did not work. Try again.');
          }}
        />
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

export default GoogleSignInButton;
