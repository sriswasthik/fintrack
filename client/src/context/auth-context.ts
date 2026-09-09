import { createContext, useContext } from 'react';

import type { AuthUser, Credentials, Registration } from '@/lib/auth';

export interface AuthState {
  user: AuthUser | null;
  /** True until the first refresh attempt settles, so routes can wait. */
  isRestoring: boolean;
  signIn: (credentials: Credentials) => Promise<void>;
  signUp: (registration: Registration) => Promise<void>;
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
