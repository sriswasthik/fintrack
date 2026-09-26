import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { DemoButton } from '@/components/DemoButton';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { useGoogleSignInAvailable } from '@/context/google-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/auth-context';
import { authErrorMessage } from '@/lib/auth';
import { safeRedirect } from '@/lib/redirect';

/** Kept in step with MIN_PASSWORD_LENGTH on the server. */
const MIN_PASSWORD_LENGTH = 10;

interface Copy {
  title: string;
  description: string;
  submit: string;
  pending: string;
  switchPrompt: string;
  switchLabel: string;
  switchTo: string;
}

const COPY: Record<'login' | 'register', Copy> = {
  login: {
    title: 'Sign in',
    description: 'Your transactions, your dashboard, your month.',
    submit: 'Sign in',
    pending: 'Signing in…',
    switchPrompt: 'No account yet?',
    switchLabel: 'Create one',
    switchTo: '/register',
  },
  register: {
    title: 'Create an account',
    description: 'Nothing is shared with anyone else who uses FinTrack.',
    submit: 'Create account',
    pending: 'Creating…',
    switchPrompt: 'Already have an account?',
    switchLabel: 'Sign in',
    switchTo: '/login',
  },
};

function Field({
  id,
  label,
  hint,
  ...props
}: React.ComponentProps<typeof Input> & { id: string; label: string; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input id={id} {...props} />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const copy = COPY[mode];
  const { user, isRestoring, signIn, signUp } = useAuth();
  const googleAvailable = useGoogleSignInAvailable();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Where the user was headed before being sent here, if anywhere. Router
   * state is attacker-reachable, so it never reaches navigate() unchecked.
   */
  const destination = safeRedirect((location.state as { from?: unknown } | null)?.from);

  if (isRestoring) {
    return (
      <output className="text-muted-foreground block p-6 text-sm" aria-live="polite">
        Restoring your session…
      </output>
    );
  }
  if (user) return <Navigate to={destination} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === 'login') await signIn({ email, password });
      else await signUp({ email, password, ...(name.trim() ? { name: name.trim() } : {}) });
      navigate(destination, { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught, 'Something went wrong. Try again.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[70svh] max-w-md flex-col justify-center p-4 sm:p-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Above the form on purpose: it is the shorter path, and a person
              who would rather use it should see it before typing a password.
              Renders nothing when the build has no Google client id. */}
          <GoogleSignInButton
            label={mode === 'login' ? 'signin_with' : 'signup_with'}
            onSignedIn={() => navigate(destination, { replace: true })}
          />

          {/* The divider belongs to the button: with no button above it, an
              "or" separates the form from nothing. */}
          {googleAvailable && (
            <div className="my-4 flex items-center gap-3">
              <span className="bg-border h-px flex-1" />
              <span className="text-muted-foreground text-xs">or</span>
              <span className="bg-border h-px flex-1" />
            </div>
          )}

          <form onSubmit={submit} className="space-y-4" noValidate>
            {mode === 'register' && (
              <Field
                id="name"
                label="Name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Optional"
              />
            )}

            <Field
              id="email"
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />

            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? MIN_PASSWORD_LENGTH : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={
                mode === 'register'
                  ? `At least ${MIN_PASSWORD_LENGTH} characters. Length beats punctuation.`
                  : undefined
              }
            />

            {mode === 'login' && (
              <p className="-mt-2 text-right text-sm">
                <Link
                  to="/forgot-password"
                  className="text-muted-foreground hover:text-foreground underline underline-offset-4"
                >
                  Forgot password?
                </Link>
              </p>
            )}

            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? copy.pending : copy.submit}
            </Button>
          </form>

          <p className="text-muted-foreground mt-4 text-sm">
            {copy.switchPrompt}{' '}
            <Link to={copy.switchTo} className="text-foreground underline underline-offset-4">
              {copy.switchLabel}
            </Link>
          </p>

          {/* Renders nothing unless the server offers demo mode. */}
          <div className="mt-4 border-t pt-4">
            <DemoButton />
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

export const LoginPage = () => <AuthPage mode="login" />;
export const RegisterPage = () => <AuthPage mode="register" />;
