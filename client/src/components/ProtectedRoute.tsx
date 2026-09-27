import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { Button } from '@/components/ui/button';
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
export function ProtectedRoute({
  children,
  writes = false,
}: {
  children: ReactNode;
  /**
   * True for a page whose whole purpose is to change something. The server
   * refuses those from a demo session, so rather than let a visitor fill in a
   * form that cannot be submitted, say plainly why it is not on offer.
   */
  writes?: boolean;
}) {
  const { user, isRestoring, isDemo } = useAuth();
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

  if (isDemo && writes) {
    return (
      <main className="mx-auto max-w-md p-6">
        <div className="bg-card space-y-3 rounded-md border p-6">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Not part of the demo
          </h1>
          <p className="text-muted-foreground text-sm">
            The sample account is shared and read-only, so importing and reviewing are turned off
            here. They work normally on an account of your own.
          </p>
          <Button asChild size="sm">
            <Link to="/register">Create an account</Link>
          </Button>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

export default ProtectedRoute;
