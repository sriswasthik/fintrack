import type { AxiosError } from 'axios';
import axios, { type InternalAxiosRequestConfig } from 'axios';

/**
 * Base URL of the Express API. Configured per environment via `VITE_API_BASE_URL`
 * (see client/.env.example); the fallback matches the server's default dev port.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

/**
 * Shared axios instance (PROJECT_CONTEXT.md §3).
 *
 * The access token is held in a module variable rather than localStorage or a
 * cookie. That is the point of a short-lived token: it lives in memory for the
 * life of the tab, so a script injected into the page has nothing durable to
 * steal, and a closed tab leaves nothing behind on a shared machine.
 */
export const api = axios.create({
  baseURL: API_BASE_URL,
  // The refresh token travels as an httpOnly cookie, so credentials must be sent.
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

let accessToken: string | null = null;

/** Called by AuthContext whenever the session starts, refreshes or ends. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

/** Marks a request that has already been retried, so it is never retried twice. */
type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

/**
 * How the app recovers a session, installed by AuthContext.
 *
 * The interceptor cannot import the context without a cycle, and it needs the
 * context to be the one place a session is stored — so the context hands its
 * refresh function down instead.
 */
let renewSession: (() => Promise<string | null>) | null = null;
let onSessionLost: (() => void) | null = null;

export function configureSessionRecovery(options: {
  renew: () => Promise<string | null>;
  onLost: () => void;
}): void {
  renewSession = options.renew;
  onSessionLost = options.onLost;
}

/**
 * One renewal in flight at a time.
 *
 * A page with four queries loading gets four 401s at once. Each would otherwise
 * refresh, and each rotation revokes the previous token — the server reads the
 * resulting replay as a stolen token and ends the session, signing the user out
 * for the crime of loading a dashboard. (`refreshSession` in lib/auth.ts is
 * single-flight for the same reason; this layer collapses the retries too, so
 * one refresh serves all four.)
 */
let inFlightRenewal: Promise<string | null> | null = null;

function renewOnce(): Promise<string | null> {
  inFlightRenewal ??= (renewSession?.() ?? Promise.resolve(null)).finally(() => {
    inFlightRenewal = null;
  });
  return inFlightRenewal;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;

    const recoverable =
      error.response?.status === 401 && config && !config._retried && renewSession !== null;

    if (!recoverable) return Promise.reject(error);

    config._retried = true;
    const token = await renewOnce();

    if (!token) {
      onSessionLost?.();
      return Promise.reject(error);
    }

    config.headers.Authorization = `Bearer ${token}`;
    return api.request(config);
  },
);
