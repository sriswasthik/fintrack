import axios from 'axios';

/**
 * Base URL of the Express API. Configured per environment via `VITE_API_BASE_URL`
 * (see client/.env.example); the fallback matches the server's default dev port.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

/**
 * Shared axios instance. Later phases attach the access-token request interceptor
 * and the 401-refresh response interceptor here (see PROJECT_CONTEXT.md §3).
 */
export const api = axios.create({
  baseURL: API_BASE_URL,
  // The refresh token travels as an httpOnly cookie, so credentials must be sent.
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});
