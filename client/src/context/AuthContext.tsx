import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { AuthContext, type AuthState } from '@/context/auth-context';
import { configureSessionRecovery, setAccessToken } from '@/lib/api';
import {
  login as loginRequest,
  logout as logoutRequest,
  refreshSession,
  register as registerRequest,
  startDemo as startDemoRequest,
  type AuthUser,
  type Session,
} from '@/lib/auth';

/**
 * Remembers that this tab is in the middle of a demo — not a token, just a
 * flag, so a reload can ask for a new demo session instead of dumping the
 * visitor at the login page.
 *
 * A real session survives a reload through its httpOnly refresh cookie. A demo
 * session is deliberately given no cookie, so there is nothing to restore it
 * from; re-requesting one is free and grants nothing, because the account is
 * public and read-only. `sessionStorage` scopes it to this tab, and access is
 * guarded because a browser set to block site data throws on the property
 * itself rather than returning null.
 */
const DEMO_FLAG = 'fintrack.demo';

function rememberDemo(active: boolean): void {
  try {
    if (active) sessionStorage.setItem(DEMO_FLAG, '1');
    else sessionStorage.removeItem(DEMO_FLAG);
  } catch {
    // Storage unavailable: the demo simply will not survive a reload.
  }
}

function wasInDemo(): boolean {
  try {
    return sessionStorage.getItem(DEMO_FLAG) === '1';
  } catch {
    return false;
  }
}

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
  const [isDemo, setIsDemo] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const queryClient = useQueryClient();

  // The recovery hook below is installed once and must renew whichever kind of
  // session is running when it fires, not the kind that was running when it was
  // installed — so the answer is kept in a ref alongside the state.
  const demoRef = useRef(false);

  // Held in a ref so the recovery hooks below never close over a stale setter.
  const applySession = useRef((session: Session | null) => {
    const demo = session?.demo === true;
    setAccessToken(session?.accessToken ?? null);
    setUser(session?.user ?? null);
    setIsDemo(demo);
    demoRef.current = demo;
    rememberDemo(demo);
  });

  const clear = useCallback(() => {
    applySession.current(null);
    // Another account's data must not survive in the cache behind a new login.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    configureSessionRecovery({
      renew: async () => {
        try {
          // A demo session has no refresh cookie to exchange — it was never
          // given one — so renewing it means asking for a fresh demo session.
          const session = demoRef.current ? await startDemoRequest() : await refreshSession();
          applySession.current(session);
          return session.accessToken;
        } catch {
          applySession.current(null);
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
        if (!cancelled) applySession.current(session);
      })
      // No cookie, or an expired one. Usually that just means nobody is signed
      // in — unless this tab was showing the demo, which never had a cookie.
      .catch(async () => {
        if (cancelled || !wasInDemo()) return;
        try {
          const session = await startDemoRequest();
          if (!cancelled) applySession.current(session);
        } catch {
          // Demo mode turned off, or the server is gone. Signed out it is.
          rememberDemo(false);
        }
      })
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
      isDemo,
      signIn: async (credentials) => {
        const session = await loginRequest(credentials);
        queryClient.clear();
        applySession.current(session);
      },
      signUp: async (registration) => {
        const session = await registerRequest(registration);
        queryClient.clear();
        applySession.current(session);
      },
      startDemo: async () => {
        const session = await startDemoRequest();
        queryClient.clear();
        applySession.current(session);
      },
      signOut: async () => {
        try {
          // A demo session has nothing on the server to revoke and no cookie
          // to clear, so there is nothing to ask for — just drop it locally.
          if (!demoRef.current) await logoutRequest();
        } finally {
          // Whether or not the server acknowledged, this browser is signed out.
          clear();
        }
      },
    }),
    [user, isRestoring, isDemo, queryClient, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
