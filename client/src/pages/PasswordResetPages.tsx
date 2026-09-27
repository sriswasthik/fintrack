import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { authErrorMessage, forgotPassword, resetPassword } from '@/lib/auth';

/** Kept in step with MIN_PASSWORD_LENGTH on the server. */
const MIN_PASSWORD_LENGTH = 10;

function Shell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[70svh] max-w-md flex-col justify-center p-4 sm:p-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

/**
 * Asks for a reset link.
 *
 * The confirmation is the server's own sentence, and it is the same for an
 * address with an account and one without — this page must not become a way
 * to find out which addresses are registered.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      setSent(await forgotPassword(email.trim()));
    } catch (caught) {
      setError(authErrorMessage(caught, 'Something went wrong. Try again.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Shell
      title="Reset your password"
      description="Enter the email you signed up with and we will send you a link to choose a new password."
    >
      {sent ? (
        <div className="space-y-4">
          <p role="status" className="text-sm">
            {sent}
          </p>
          <p className="text-muted-foreground text-sm">
            Nothing after a few minutes? Check your spam folder, or try again.
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending || !email.trim()}>
            {pending ? 'Sending…' : 'Send reset link'}
          </Button>
          <p className="text-muted-foreground text-sm">
            Remembered it?{' '}
            <Link to="/login" className="text-foreground underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </Shell>
  );
}

/**
 * Where the emailed link lands: `/reset-password?token=…`.
 *
 * On success every existing session has been ended by the server, so the
 * person is sent to sign in with the new password rather than signed in here.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!token) {
    return (
      <Shell
        title="This link is incomplete"
        description="The reset link is missing its token — it may have been cut off when it was copied."
      >
        <Button asChild className="w-full">
          <Link to="/forgot-password">Ask for a new link</Link>
        </Button>
      </Shell>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setPending(true);
    try {
      setDone(await resetPassword({ token, password }));
    } catch (caught) {
      setError(authErrorMessage(caught, 'Something went wrong. Try again.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Shell title="Choose a new password" description="The link works once, for an hour.">
      {done ? (
        <div className="space-y-4">
          <p role="status" className="text-sm">
            {done}
          </p>
          <Button asChild className="w-full">
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              New password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              At least {MIN_PASSWORD_LENGTH} characters. Length beats punctuation.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="confirm" className="text-sm font-medium">
              Confirm new password
            </label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}{' '}
              {/expired|invalid|already used/i.test(error) && (
                <Link to="/forgot-password" className="underline underline-offset-4">
                  Ask for a new link.
                </Link>
              )}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={pending || password.length < MIN_PASSWORD_LENGTH || !confirm}
          >
            {pending ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
    </Shell>
  );
}
