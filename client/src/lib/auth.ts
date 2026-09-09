import axios from 'axios';

import { API_BASE_URL } from '@/lib/api';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
  /** True for the shared read-only sample account. */
  demo?: boolean;
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

/** Re-exported so auth pages and data pages phrase a failure the same way. */
export { errorMessage as authErrorMessage } from '@/lib/errors';
