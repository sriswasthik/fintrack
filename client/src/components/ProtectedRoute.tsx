import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '@/context/auth-context';
import { safeRedirect } from '@/lib/redirect';

/**
 * Gate for everything that needs a session.
 *
 * The wait on `isRestoring` matters: on a reload the app has a refresh cookie
 * but no access token yet, and redirecting before that exchange settles would
 * bounce a signed-in person to the login page on every refresh.
 *
 * Where they were going is remembered, so signing in continues the journey
 * rather than dumping them on the dashboard.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isRestoring } = useAuth();
  const location = useLocation();

  if (isRestoring) {
    return (
      <output className="text-muted-foreground block p-6 text-sm" aria-live="polite">
        Restoring your session…
      </output>
    );
  }

  if (!user) {
    const from = safeRedirect(location.pathname + location.search);
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return <>{children}</>;
}

export default ProtectedRoute;
