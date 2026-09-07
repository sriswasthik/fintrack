import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { API_BASE_URL } from '@/lib/api';
import { fetchHealth } from '@/lib/health';

/**
 * Phase 0 placeholder page. Its only job is to prove the client can reach the
 * Express API in dev: it calls `GET /api/health` through `VITE_API_BASE_URL`
 * and renders whatever comes back.
 */
export function HomePage() {
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 p-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">FinTrack</h1>
        <p className="text-muted-foreground text-sm">
          Personal finance transaction categorizer &amp; dashboard — scaffolding only.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API health check</CardTitle>
          <CardDescription>
            <code>GET {API_BASE_URL}/api/health</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-4">
          {isPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              Checking API…
            </p>
          ) : error ? (
            <div role="alert" className="space-y-2">
              <Badge variant="destructive">unreachable</Badge>
              <p className="text-muted-foreground text-sm">
                Could not reach the API at <code>{API_BASE_URL}</code>. Is the server running?
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Badge>{data.status}</Badge>
              <p className="text-muted-foreground text-sm">
                The client reached the API successfully.
              </p>
            </div>
          )}

          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Checking…' : 'Re-check'}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export default HomePage;
