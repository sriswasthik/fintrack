import axios from 'axios';

import { API_BASE_URL } from '@/lib/api';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The Google client id this build was compiled with.
 *
 * Empty when the deployment does not offer Google sign-in, which is a normal
 * state rather than an error: the buttons simply do not render. Only
 * `VITE_`-prefixed values reach the bundle, and a client id is public by
 * design — it identifies the app to Google, it does not authorise anything.
 *
 * Read on each call rather than captured at module load. Vite inlines the value
 * at build time either way, so production is unaffected; what it buys is a test
 * that can turn the feature on and off without reloading modules.
 */
export function googleClientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
}

export function googleSignInEnabled(): boolean {
  return googleClientId().length > 0;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
  /** True for the shared read-only sample account. */
  demo?: boolean;
  /**
   * Google sign-in only. True when this request is what created the account —
   * not merely the first time Google was used on it. Phase 17 sends a welcome
   * email from this.
   */
  isNewUser?: boolean;
  /** Which of the three account paths ran. Returned by the Google endpoint. */
  resolution?: 'signed-in' | 'linked' | 'created';
}

export interface Credentials {
  email: string;
  password: string;
}

export interface Registration extends Credentials {
  name?: string;
}

/**
 * A second axios instance, deliberately without the interceptors.
 *
 * The auth calls are what the interceptors *use* to recover from a 401; routing
 * them through the same instance would let a failed refresh trigger another
 * refresh, and so on. Keeping them on a plain client makes that impossible
 * rather than merely unlikely.
 */
export const authApi = axios.create({
  baseURL: API_BASE_URL,
  // The refresh token is an httpOnly cookie, so credentials must be sent.
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

export async function register(body: Registration): Promise<Session> {
  const { data } = await authApi.post<Session>('/api/auth/register', body);
  return data;
}

export async function login(body: Credentials): Promise<Session> {
  const { data } = await authApi.post<Session>('/api/auth/login', body);
  return data;
}

/**
 * Exchanges a Google ID token for the same session the password routes issue.
 *
 * The credential is the JWT Google handed the browser. Nothing is read out of
 * it here — the server verifies the signature and takes the email, name and
 * picture from the verified payload, because anything this code parsed would
 * be as forgeable as the request that carried it.
 */
export async function signInWithGoogle(credential: string): Promise<Session> {
  const { data } = await authApi.post<Session>('/api/auth/google', { credential });
  return data;
}

/**
 * Starts a read-only session on the shared sample account.
 *
 * Unlike a real session this one has no refresh cookie behind it, so when it
 * expires the way to renew it is to ask for another — which is what the
 * context installs as the recovery hook while a demo is running.
 */
export async function startDemo(): Promise<Session> {
  const { data } = await authApi.post<Session>('/api/auth/demo', {});
  return data;
}

/**
 * One refresh in flight at a time, process-wide.
 *
 * Every use of a refresh token rotates it, and the server treats a spent token
 * coming back as a stolen one — it ends every session for that user. That is
 * the behaviour we want against a real thief, which makes it essential that
 * this app never presents the same token twice.
 *
 * Two things would otherwise do exactly that. React's StrictMode invokes mount
 * effects twice in development, so the session restore fires twice; and a page
 * that loads four queries at once gets four 401s at once. Both collapse into a
 * single request here, so a rotation is never racing itself.
 */
let inFlight: Promise<Session> | null = null;

/**
 * Exchanges the refresh cookie for a new session.
 *
 * Throws when there is no valid cookie, which is the normal case for someone
 * who has never signed in — the caller treats that as "signed out", not as an
 * error worth showing.
 */
export function refreshSession(): Promise<Session> {
  inFlight ??= authApi
    .post<Session>('/api/auth/refresh')
    .then((response) => response.data)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function logout(): Promise<void> {
  await authApi.post('/api/auth/logout');
}

/**
 * Asks for a reset link. The answer is the same whether or not the address
 * has an account, so all a caller can show is the server's own wording.
 */
export async function forgotPassword(email: string): Promise<string> {
  const { data } = await authApi.post<{ message: string }>('/api/auth/forgot-password', { email });
  return data.message;
}

/** Spends a reset link on a new password. Every existing session ends. */
export async function resetPassword(input: { token: string; password: string }): Promise<string> {
  const { data } = await authApi.post<{ message: string }>('/api/auth/reset-password', input);
  return data.message;
}

/** Re-exported so auth pages and data pages phrase a failure the same way. */
export { errorMessage as authErrorMessage } from '@/lib/errors';
