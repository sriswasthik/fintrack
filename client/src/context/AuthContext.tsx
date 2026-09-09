import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { AuthContext, type AuthState } from '@/context/auth-context';
import { configureSessionRecovery, setAccessToken } from '@/lib/api';
import {
  login as loginRequest,
  logout as logoutRequest,
  refreshSession,
  register as registerRequest,
  type AuthUser,
} from '@/lib/auth';

/**
 * The session, held in memory.
 *
 * The access token never reaches this component's state — it goes straight to
 * the axios module, which is the only thing that needs it. Keeping it out of
 * React state means it cannot end up in a devtools snapshot, an error report or
 * a server-rendered payload by accident. What lives here is who is signed in,
 * which is the part the UI actually renders.
 *
 * On mount the app tries once to exchange the refresh cookie for a session.
 * That is what makes a reload keep you signed in without storing anything
 * readable in the browser.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const queryClient = useQueryClient();

  // Held in a ref so the recovery hooks below never close over a stale setter.
  const applySession = useRef((nextUser: AuthUser | null, token: string | null) => {
    setAccessToken(token);
    setUser(nextUser);
  });

  const clear = useCallback(() => {
    applySession.current(null, null);
    // Another account's data must not survive in the cache behind a new login.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    configureSessionRecovery({
      renew: async () => {
        try {
          const session = await refreshSession();
          applySession.current(session.user, session.accessToken);
          return session.accessToken;
        } catch {
          applySession.current(null, null);
          return null;
        }
      },
      onLost: clear,
    });
  }, [clear]);

  useEffect(() => {
    let cancelled = false;

    refreshSession()
      .then((session) => {
        if (!cancelled) applySession.current(session.user, session.accessToken);
      })
      // No cookie, or an expired one: not an error, just nobody signed in.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsRestoring(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isRestoring,
      signIn: async (credentials) => {
        const session = await loginRequest(credentials);
        queryClient.clear();
        applySession.current(session.user, session.accessToken);
      },
      signUp: async (registration) => {
        const session = await registerRequest(registration);
        queryClient.clear();
        applySession.current(session.user, session.accessToken);
      },
      signOut: async () => {
        try {
          await logoutRequest();
        } finally {
          // Whether or not the server acknowledged, this browser is signed out.
          clear();
        }
      },
    }),
    [user, isRestoring, queryClient, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
