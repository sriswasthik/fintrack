import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL, createAccount, type AccountType } from '@/lib/accounts';
import { errorMessage } from '@/lib/errors';
import type { Account } from '@/lib/transactions';

/**
 * Adds a bank account.
 *
 * Every import has to name the account it goes into, and a new user has none
 * — so without this on the import page, signing up led to a dropdown with
 * nothing in it and no way forward. Used there and on the settings page.
 */
export function AddAccountForm({
  onCreated,
  onCancel,
  submitLabel = 'Add account',
}: {
  onCreated?: (account: Account) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('CHECKING');

  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: (account) => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onCreated?.(account);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({ name: name.trim(), type });
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Add a bank account">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <label htmlFor="new-account-name" className="text-sm font-medium">
            Account name
          </label>
          <Input
            id="new-account-name"
            value={name}
            maxLength={120}
            placeholder="e.g. HDFC Savings"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:w-64">
          <label htmlFor="new-account-type" className="text-sm font-medium">
            Type
          </label>
          <Select value={type} onValueChange={(value) => setType(value as AccountType)}>
            <SelectTrigger id="new-account-type" aria-label="Account type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {ACCOUNT_TYPE_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {mutation.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(mutation.error)}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!name.trim() || mutation.isPending}>
          {mutation.isPending ? 'Adding…' : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
