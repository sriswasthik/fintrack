import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';

/**
 * The three things every page has to be able to say.
 *
 * Shared rather than written per page so they read alike: the same tone, the
 * same amount of space, the same place on the card. A dashboard that says
 * "Loading…" where the review queue says "Please wait" is a page that looks
 * assembled by different people.
 */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <output aria-live="polite" className="text-muted-foreground block py-8 text-center text-sm">
      {label}
    </output>
  );
}

/**
 * Nothing to show, and why.
 *
 * An empty state that only says "no data" leaves a person stuck. Every one of
 * these says what would put something here, and offers the button that does it
 * where there is one.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-muted-foreground max-w-sm text-sm">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  fallback,
}: {
  error: unknown;
  onRetry?: () => void;
  fallback?: string;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-destructive text-sm">{errorMessage(error, fallback)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
