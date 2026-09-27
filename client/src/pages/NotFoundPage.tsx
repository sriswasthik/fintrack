import { Link, useLocation } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';

/**
 * Any path no route claims. Before this, an unknown URL rendered the nav bar
 * over an empty page — which reads as a broken app rather than a wrong link.
 */
export function NotFoundPage() {
  const { user } = useAuth();
  const location = useLocation();

  return (
    <main className="mx-auto flex min-h-[60svh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-muted-foreground text-sm font-medium">404</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight">There is no page here</h1>
      <p className="text-muted-foreground text-sm break-all">
        Nothing lives at <code className="font-mono">{location.pathname}</code>. The link may be
        old, or mistyped.
      </p>
      <Button asChild>
        <Link to={user ? '/dashboard' : '/'}>{user ? 'Go to your dashboard' : 'Go home'}</Link>
      </Button>
    </main>
  );
}

export default NotFoundPage;
