import { createContext, useContext } from 'react';

import type { AuthUser, Credentials, Registration } from '@/lib/auth';

export interface AuthState {
  user: AuthUser | null;
  /** True until the first refresh attempt settles, so routes can wait. */
  isRestoring: boolean;
  /**
   * True while viewing the shared sample account. The server refuses writes
   * from this session; the UI hides them so nobody is offered a button that
   * only produces a 403.
   */
  isDemo: boolean;
  signIn: (credentials: Credentials) => Promise<void>;
  signUp: (registration: Registration) => Promise<void>;
  /**
   * Signs in with a Google ID token. Resolves to whether the account was
   * created by this request, which the caller uses only to choose wording.
   */
  signInWithGoogle: (credential: string) => Promise<{ isNewUser: boolean }>;
  startDemo: () => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * Split from the provider so the module exports only hooks and values.
 * A file that exports both a component and a hook breaks fast refresh.
 */
export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
