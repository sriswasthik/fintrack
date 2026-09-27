import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';

/**
 * Says what a visitor is looking at while a demo session is running.
 *
 * Two jobs: nobody should mistake the sample account for their own data, and
 * anybody who likes what they see should be one click from an account of their
 * own. It renders nothing at all for a normal session.
 */
export function DemoBanner() {
  const { isDemo, signOut } = useAuth();

  if (!isDemo) return null;

  return (
    <div className="bg-secondary border-b">
      <div className="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6">
        <span>
          <span className="eyebrow text-foreground mr-2">Demo</span>
          You are viewing a <strong className="text-foreground">
            read-only sample account
          </strong>{' '}
          with generated data.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link to="/register">Create your own</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void signOut()}>
            Leave demo
          </Button>
        </div>
      </div>
    </div>
  );
}

export default DemoBanner;
