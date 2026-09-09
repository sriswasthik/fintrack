import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';
import { authErrorMessage } from '@/lib/auth';
import { fetchHealth } from '@/lib/health';

/**
 * "See it with sample data" — the way in for someone who does not want to make
 * an account yet.
 *
 * It only appears when the server says it offers demo mode, so a private
 * deployment never advertises a door that is not there.
 */
export function DemoButton({ variant = 'outline' }: { variant?: 'default' | 'outline' }) {
  const { startDemo } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });

  if (!health.data?.demo) return null;

  const enter = async () => {
    setError(null);
    setPending(true);
    try {
      await startDemo();
      navigate('/dashboard', { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught, 'The demo is unavailable right now.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Button variant={variant} onClick={() => void enter()} disabled={pending}>
        {pending ? 'Loading the demo…' : 'See it with sample data'}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export default DemoButton;
