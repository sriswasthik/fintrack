/**
 * Sending the welcome email (Phase 17).
 *
 * One function, called from exactly two places, and the reason it is a function
 * rather than two inline blocks is that "who gets welcomed" is a rule worth
 * stating once: **only an account that this request brought into existence.**
 *
 * Registration is that by definition. Google is not — Phase 16's
 * `isNewUser` distinguishes creating an account from linking Google to one that
 * already existed, and from an ordinary repeat sign-in. Welcoming somebody who
 * has had an account since March because they happened to use a new button is
 * the failure this guards against.
 */
import { appUrl, sendInBackground } from './send';
import { renderWelcomeEmail } from './templates/welcome';

export interface WelcomeRecipient {
  email: string;
  name?: string | null;
}

/**
 * Queues the welcome email and returns immediately.
 *
 * Returns nothing on purpose. There is no outcome a caller could act on: the
 * response has already been sent, the person is already signed in, and whether
 * the email arrives changes neither. Failures are logged where an operator can
 * see them (see `sendInBackground`).
 */
export function sendWelcomeEmail(recipient: WelcomeRecipient): void {
  const { subject, html, text } = renderWelcomeEmail({
    name: recipient.name,
    appUrl: appUrl(),
  });

  sendInBackground({ to: recipient.email, subject, html, text }, 'welcome');
}
