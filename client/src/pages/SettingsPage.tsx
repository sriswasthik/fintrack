import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import { AddAccountForm } from '@/components/AddAccountForm';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/context/auth-context';
import {
  ACCOUNT_TYPE_LABEL,
  TRANSACTION_DERIVED_QUERIES,
  deleteAccount,
  fetchImports,
  undoImport,
  updateAccount,
  type AccountType,
  type ImportRecord,
} from '@/lib/accounts';
import { errorMessage } from '@/lib/errors';
import { changePassword, deleteMyAccount, fetchProfile } from '@/lib/me';
import { fetchAccounts, type Account } from '@/lib/transactions';

/** Kept in step with MIN_PASSWORD_LENGTH on the server. */
const MIN_PASSWORD_LENGTH = 10;

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Removing rows moves every total on every page, so all of them are refetched. */
function useInvalidateEverything() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of TRANSACTION_DERIVED_QUERIES) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/**
 * Settings: the person's bank accounts, what they have imported, their
 * password, and the way out.
 *
 * A demo session sees the page read-only. The server refuses every write it
 * could make; offering buttons that only produce a 403 would be a tease.
 */
export function SettingsPage() {
  const { isDemo } = useAuth();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Your bank accounts, your imports, and your sign-in. Corrections you have taught FinTrack
          are on the{' '}
          <Link to="/rules" className="text-foreground underline underline-offset-4">
            learned rules
          </Link>{' '}
          page.
        </p>
      </div>

      {isDemo && (
        <p role="status" className="bg-muted rounded-md p-3 text-sm">
          This is the shared sample account, so everything here is read-only.
        </p>
      )}

      <ProfileCard />
      <AccountsCard readOnly={isDemo} />
      <ImportsCard readOnly={isDemo} />
      {!isDemo && <PasswordCard />}
      {!isDemo && <DeleteAccountCard />}
    </main>
  );
}

function ProfileCard() {
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const data = profile.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>How you sign in to FinTrack.</CardDescription>
      </CardHeader>
      <CardContent>
        {profile.isPending && <Loading />}
        {profile.isError && (
          <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
        )}
        {data && (
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{data.email}</dd>
            {data.name && (
              <>
                <dt className="text-muted-foreground">Name</dt>
                <dd>{data.name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Sign-in methods</dt>
            <dd className="flex flex-wrap gap-1.5">
              {data.hasPassword && <Badge variant="secondary">Password</Badge>}
              {data.hasGoogle && <Badge variant="secondary">Google</Badge>}
            </dd>
            <dt className="text-muted-foreground">Member since</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function AccountsCard({ readOnly }: { readOnly: boolean }) {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const invalidate = useInvalidateEverything();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<Account | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteAccount(id),
    onSuccess: () => {
      setDoomed(null);
      invalidate();
    },
  });

  const list = accounts.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Bank accounts</CardTitle>
          <CardDescription>
            Each import goes into one of these. Two accounts are what let a transfer between them be
            recognised as moving your own money rather than spending it.
          </CardDescription>
        </div>
        {!readOnly && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add account
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {adding && (
          <div className="rounded-md border p-4">
            <AddAccountForm onCreated={() => setAdding(false)} onCancel={() => setAdding(false)} />
          </div>
        )}

        {accounts.isPending && <Loading label="Loading accounts…" />}
        {accounts.isError && (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        )}
        {accounts.isSuccess && list.length === 0 && !adding && (
          <EmptyState
            title="No accounts yet"
            description="Add the account your first statement belongs to, then import it."
          />
        )}

        {list.length > 0 && (
          <ul className="divide-y">
            {list.map((account) =>
              editing === account.id ? (
                <li key={account.id} className="py-3">
                  <RenameAccount account={account} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <li key={account.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{account.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {ACCOUNT_TYPE_LABEL[account.type as AccountType] ?? account.type} ·{' '}
                      {plural(account.transactionCount ?? 0, 'transaction')}
                    </p>
                  </div>
                  {!readOnly && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(account.id)}>
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        aria-label={`Delete ${account.name}`}
                        onClick={() => {
                          remove.reset();
                          setDoomed(account);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={doomed !== null}
        title={`Delete ${doomed?.name ?? 'this account'}?`}
        description={
          <>
            <p>
              This removes the account and{' '}
              <strong>{plural(doomed?.transactionCount ?? 0, 'transaction')}</strong> in it, along
              with every import into it. It cannot be undone.
            </p>
            <p>
              Transfers to and from your other accounts will be re-checked, and anybody you only
              ever paid from this account will leave your People &amp; Businesses list.
            </p>
          </>
        }
        confirmLabel="Delete account"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => doomed && remove.mutate(doomed.id)}
        onCancel={() => setDoomed(null)}
      />
    </Card>
  );
}

function RenameAccount({ account, onDone }: { account: Account; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(account.name);

  const mutation = useMutation({
    mutationFn: updateAccount,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      onDone();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === account.name) return onDone();
    mutation.mutate({ id: account.id, name: trimmed });
  };

  return (
    <form onSubmit={submit} className="space-y-2" aria-label={`Rename ${account.name}`}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`rename-${account.id}`} className="sr-only">
          New name for {account.name}
        </label>
        <Input
          id={`rename-${account.id}`}
          value={name}
          maxLength={120}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(mutation.error)}
        </p>
      )}
    </form>
  );
}

function ImportsCard({ readOnly }: { readOnly: boolean }) {
  const imports = useQuery({ queryKey: ['imports'], queryFn: fetchImports });
  const invalidate = useInvalidateEverything();
  const [doomed, setDoomed] = useState<ImportRecord | null>(null);

  const undo = useMutation({
    mutationFn: (id: string) => undoImport(id),
    onSuccess: () => {
      setDoomed(null);
      invalidate();
    },
  });

  const list = imports.data ?? [];
  const span = (record: ImportRecord) =>
    record.from && record.to
      ? record.from === record.to
        ? record.from
        : `${record.from} – ${record.to}`
      : '—';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import history</CardTitle>
        <CardDescription>
          Every statement you have confirmed. Imported the wrong file, or into the wrong account?
          Undo it and every row it brought in goes, as if it had never been imported.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {imports.isPending && <Loading label="Loading imports…" />}
        {imports.isError && (
          <ErrorState error={imports.error} onRetry={() => void imports.refetch()} />
        )}
        {imports.isSuccess && list.length === 0 && (
          <EmptyState
            title="Nothing imported yet"
            description="Statements you import will be listed here."
            action={
              readOnly ? undefined : (
                <Button asChild size="sm">
                  <Link to="/upload">Import a statement</Link>
                </Button>
              )
            }
          />
        )}
        {list.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Imported</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Files</TableHead>
                  <TableHead>Covers</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  {!readOnly && <TableHead className="w-20" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(record.createdAt)}
                    </TableCell>
                    <TableCell>{record.account.name}</TableCell>
                    <TableCell className="max-w-[14rem] truncate text-xs">
                      {record.fileNames.length > 0 ? record.fileNames.join(', ') : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{span(record)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {record.remaining === record.rowCount
                        ? record.rowCount
                        : `${record.remaining} of ${record.rowCount}`}
                    </TableCell>
                    {!readOnly && (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Undo import of ${record.fileNames.join(', ') || record.id}`}
                          onClick={() => {
                            undo.reset();
                            setDoomed(record);
                          }}
                        >
                          Undo
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={doomed !== null}
        title="Undo this import?"
        description={
          <p>
            This removes the <strong>{plural(doomed?.remaining ?? 0, 'transaction')}</strong> it
            brought into {doomed?.account.name ?? 'the account'}, including any you have since
            recategorized. Rules you taught from them are kept.
          </p>
        }
        confirmLabel="Undo import"
        pending={undo.isPending}
        error={undo.error}
        onConfirm={() => doomed && undo.mutate(doomed.id)}
        onCancel={() => setDoomed(null)}
      />
    </Card>
  );
}

function PasswordCard() {
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMismatch(next !== confirm);
    if (next !== confirm) return;
    mutation.mutate({ currentPassword: current, newPassword: next });
  };

  if (profile.data && !profile.data.hasPassword) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            You sign in with Google, so this account has no password. To add one, use{' '}
            <Link to="/forgot-password" className="text-foreground underline underline-offset-4">
              Forgot password
            </Link>{' '}
            — the link it emails you sets your first one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Everywhere else you are signed in will be signed out. This browser stays signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="max-w-md space-y-3" aria-label="Change password">
          <PasswordField
            id="current-password"
            label="Current password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
          <PasswordField
            id="new-password"
            label="New password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          />
          <PasswordField
            id="confirm-password"
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />

          {mismatch && (
            <p role="alert" className="text-destructive text-sm">
              The two new passwords do not match.
            </p>
          )}
          {mutation.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(mutation.error)}
            </p>
          )}
          {mutation.isSuccess && (
            <p role="status" className="text-sm">
              Password changed. Other sessions have been signed out.
            </p>
          )}

          <Button
            type="submit"
            disabled={
              mutation.isPending || !current || next.length < MIN_PASSWORD_LENGTH || !confirm
            }
          >
            {mutation.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function DeleteAccountCard() {
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: deleteMyAccount,
    onSuccess: async () => {
      await signOut();
      navigate('/', { replace: true });
    },
  });

  const needsPassword = profile.data?.hasPassword ?? true;
  const matches = email.trim().toLowerCase() === profile.data?.email.toLowerCase();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    mutation.mutate({ email: email.trim(), ...(needsPassword ? { password } : {}) });
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete your account</CardTitle>
        <CardDescription>
          Removes you and everything FinTrack holds for you — every account, transaction, import,
          rule, budget and summary. There is no undo and no grace period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="max-w-md space-y-3" aria-label="Delete your account">
          <div className="space-y-1.5">
            <label htmlFor="delete-email" className="text-sm font-medium">
              Type your email address to confirm
            </label>
            <Input
              id="delete-email"
              type="email"
              autoComplete="off"
              value={email}
              placeholder={profile.data?.email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {needsPassword && (
            <PasswordField
              id="delete-password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
          )}
          {mutation.isError && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(mutation.error)}
            </p>
          )}
          <Button
            type="submit"
            variant="destructive"
            disabled={!matches || (needsPassword && !password) || mutation.isPending}
          >
            {mutation.isPending ? 'Deleting…' : 'Delete my account'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default SettingsPage;
