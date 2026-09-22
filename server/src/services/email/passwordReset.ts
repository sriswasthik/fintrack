/**
 * Sending the password reset email (Phase 20).
 *
 * Best-effort and non-blocking like the welcome email, and for a further
 * reason here: the forgot-password endpoint answers identically whether or
 * not the address has an account, and a response that waited on the mail
 * provider would take measurably longer for a real account than for a
 * made-up one.
 */
import { RESET_TOKEN_TTL_MINUTES } from '../auth/passwordReset';
import { appUrl, emailConfigured, sendInBackground } from './send';
import { renderPasswordResetEmail } from './templates/password-reset';

export interface ResetRecipient {
  email: string;
  name?: string | null;
}

/** The link a reset email carries. */
export function resetLink(token: string): string {
  return `${appUrl().replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

export function sendPasswordResetEmail(recipient: ResetRecipient, token: string): void {
  const resetUrl = resetLink(token);

  // A local checkout has no mail provider, and a reset flow that cannot be
  // tried locally does not get tried. Outside production only, the link goes
  // to the server console instead. Never in production: a log line holding a
  // live credential is a credential in the log pipeline.
  if (!emailConfigured() && process.env.NODE_ENV !== 'production') {
    console.warn(
      `[email] no mail provider configured; reset link for ${recipient.email}: ${resetUrl}`,
    );
    return;
  }

  const { subject, html, text } = renderPasswordResetEmail({
    name: recipient.name,
    resetUrl,
    ttlMinutes: RESET_TOKEN_TTL_MINUTES,
  });
  sendInBackground({ to: recipient.email, subject, html, text }, 'password reset');
}
