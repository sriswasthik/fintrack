import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorMessage } from '@/lib/errors';

/**
 * Asks before something that cannot be taken back.
 *
 * An in-page dialog rather than `window.confirm`: it can say exactly what
 * will go ("412 transactions"), it shows the server's error in place if the
 * action fails, and it does not block the whole tab while it waits.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
