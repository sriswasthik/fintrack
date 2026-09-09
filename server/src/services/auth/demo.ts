/**
 * Demo mode (PROJECT_CONTEXT.md §9).
 *
 * A portfolio visitor should be able to see a real dashboard without inventing
 * a password, so the deployment can hand out a session for one seeded account
 * holding the synthetic dataset. That session is read-only, enforced on the
 * server rather than by hiding buttons: see `requireWritableSession`.
 *
 * It is opt-in per deployment. A private instance holding somebody's actual
 * bank history has no business issuing sessions to anonymous callers, so the
 * route stays off until `DEMO_MODE=on` says otherwise.
 */

/** The account demo sessions are issued for. Seeded by `npm run demo:seed`. */
export function demoUserEmail(): string {
  return process.env.DEMO_USER_EMAIL ?? 'demo@fintrack.local';
}

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'on';
}

/**
 * How long a demo session lasts.
 *
 * Longer than a normal access token because there is no refresh cookie to
 * renew it from — a visitor reading the dashboard should not be interrupted,
 * and the token grants nothing but read access to public sample data.
 */
export const DEMO_SESSION_TTL_SECONDS = 2 * 60 * 60;
