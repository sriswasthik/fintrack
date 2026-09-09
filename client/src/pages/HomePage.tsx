import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { DemoButton } from '@/components/DemoButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/context/auth-context';
import { API_BASE_URL } from '@/lib/api';
import { fetchHealth } from '@/lib/health';

const WHAT_IT_DOES = [
  [
    'Import a statement',
    'CSV from any bank. Duplicates are flagged for you to resolve, never dropped.',
  ],
  [
    'Categorized automatically',
    'Deterministic rules first, a model only for what they cannot settle.',
  ],
  ['See where it went', 'Transfers excluded, refunds netted, splits counted once.'],
  [
    'Told what changed',
    'Unusual charges, new subscriptions and price rises, from plain statistics.',
  ],
];

/**
 * The landing page.
 *
 * It has two audiences and says something useful to each: a visitor with no
 * account needs to know what this is before being asked to make one, and a
 * signed-in person arriving at `/` should be pointed at their month rather than
 * shown marketing.
 */
export function HomePage() {
  const { user, isRestoring } = useAuth();

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-4 py-10 sm:p-6 sm:py-14">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Where your money actually went</h1>
        <p className="text-muted-foreground max-w-prose">
          FinTrack reads a bank export, works out what each charge was, and shows you the month —
          including the parts that are easy to get wrong: transfers between your own accounts,
          refunds against the thing they refunded, and one charge split across categories.
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isRestoring ? (
            <output aria-live="polite" className="text-muted-foreground text-sm">
              Restoring your session…
            </output>
          ) : user ? (
            <>
              <Button asChild>
                <Link to="/dashboard">Open your dashboard</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/upload">Import a statement</Link>
              </Button>
            </>
          ) : (
            <>
              <Button asChild>
                <Link to="/register">Create an account</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/login">Sign in</Link>
              </Button>
              <DemoButton />
            </>
          )}
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {WHAT_IT_DOES.map(([title, description]) => (
          <Card key={title} className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      {/* Kept from Phase 0: the fastest way to tell a misconfigured dev setup
          from a broken app. Quiet when everything is fine. */}
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">API connection</CardTitle>
          <CardDescription>
            <code>{API_BASE_URL}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {health.isPending ? (
            <output aria-live="polite" className="text-muted-foreground text-sm">
              Checking API…
            </output>
          ) : health.isError ? (
            <div role="alert" className="space-y-2">
              <Badge variant="destructive">unreachable</Badge>
              <p className="text-muted-foreground text-sm">
                Could not reach the API. Is the server running, and does{' '}
                <code>VITE_API_BASE_URL</code> point at it?
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge>{health.data.status}</Badge>
              <span className="text-muted-foreground text-sm">Reachable.</span>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default HomePage;
