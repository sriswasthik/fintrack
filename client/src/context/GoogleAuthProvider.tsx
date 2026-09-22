import { useState, type ReactNode } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';

import { GoogleScriptContext, type GoogleScriptState } from '@/context/google-auth';
import { googleClientId, googleSignInEnabled } from '@/lib/auth';

/**
 * Loads Google's identity script, when there is a client id to load it for.
 *
 * Wrapped rather than used directly for two reasons.
 *
 * A build with no client id never renders the provider at all, so Google's
 * script is not fetched — an instance that does not use Google also does not
 * send its visitors to google.com on every page load. Using
 * `GoogleOAuthProvider` with an empty client id would load the script and then
 * fail at the button, which is a worse outcome than never offering it.
 *
 * And the script can simply fail to arrive: a corporate network, a content
 * blocker, an outage. That is published here so the buttons can take
 * themselves down rather than leave a gap where one should be.
 */
export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GoogleScriptState>('pending');

  if (!googleSignInEnabled()) {
    return <GoogleScriptContext.Provider value="disabled">{children}</GoogleScriptContext.Provider>;
  }

  return (
    <GoogleOAuthProvider
      clientId={googleClientId()}
      onScriptLoadSuccess={() => setState('ready')}
      onScriptLoadError={() => setState('unavailable')}
    >
      <GoogleScriptContext.Provider value={state}>{children}</GoogleScriptContext.Provider>
    </GoogleOAuthProvider>
  );
}

export default GoogleAuthProvider;
