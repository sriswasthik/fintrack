/**
 * Transactional email.
 *
 * **Provider: Resend.** Chosen over Nodemailer + SMTP because the whole of it
 * is an API key and an HTTPS call — no connection pool to manage, no SMTP
 * credentials to rotate, no port 587 to argue with a hosting platform about.
 * The trade is a vendor dependency, which is contained here: everything above
 * this file talks to `sendEmail`, so swapping in an SMTP transport later means
 * rewriting one function rather than finding every caller.
 *
 * Nothing here is allowed to break a request. Sending is best-effort by
 * design — see `sendInBackground` below, and PROJECT_CONTEXT.md §12 for the
 * environment variables.
 */
import { Resend } from 'resend';

/** Set on a deployment that can send mail. Absent locally, and that is fine. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/**
 * Where the app lives, for links inside an email.
 *
 * Falls back to `CORS_ORIGIN`, which a working deployment has already had to
 * set to the client's URL — so a correctly configured server gets a correct
 * link without a second variable to forget.
 */
export function appUrl(): string {
  return process.env.APP_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173';
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Always sent alongside the HTML. See the template for why. */
  text: string;
}

export interface SendResult {
  /** False when the deployment cannot send mail, or the provider refused. */
  sent: boolean;
  /** Provider id for a successful send, for tracing a delivery later. */
  id?: string;
  /** Why it did not send. Logged, never returned to a caller's caller. */
  reason?: string;
}

/** One client, reused across requests. */
let client: Resend | null = null;
function resend(): Resend {
  client ??= new Resend(process.env.RESEND_API_KEY);
  return client;
}

/** Test seam — lets the suites drive a stub instead of reaching Resend. */
export function setEmailClient(replacement: Resend | null): void {
  client = replacement;
}

/**
 * Sends one message, and never throws.
 *
 * Every failure — misconfiguration, a rejected key, a network blip, a malformed
 * address — comes back as `{ sent: false, reason }`. Callers are transactional
 * paths where an email is a courtesy and the request is the product, so there
 * is no failure here worth turning into an exception somebody upstream has to
 * remember to catch.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  if (!emailConfigured()) {
    return {
      sent: false,
      reason: 'RESEND_API_KEY and EMAIL_FROM are not set; skipping send',
    };
  }

  try {
    const { data, error } = await resend().emails.send({
      from: process.env.EMAIL_FROM!,
      to: message.to,
      subject: message.subject,
      html: message.html,
      // Sent as well as the HTML, not instead of it. A multipart message reads
      // correctly in a plain-text client, and a message with no text part at
      // all is itself a spam signal.
      text: message.text,
    });

    // The SDK reports a refusal in `error` rather than by throwing.
    if (error) return { sent: false, reason: `${error.name}: ${error.message}` };
    return { sent: true, ...(data?.id ? { id: data.id } : {}) };
  } catch (caught) {
    return { sent: false, reason: caught instanceof Error ? caught.message : 'Unknown error' };
  }
}

/**
 * Sends without making the caller wait, and without letting a failure escape.
 *
 * This is the shape every caller in this phase uses. The request has already
 * been answered by the time the promise settles, so:
 *
 *   * it is **not awaited** — a slow provider must not hold a registration open
 *   * it **cannot reject** — `sendEmail` does not throw, and the `.catch` here
 *     is a second belt, because an unhandled rejection in Node is fatal by
 *     default and a courtesy email must never be able to take the server down
 *   * every outcome is **logged server-side**, which is the only place a
 *     failure is visible: the person registering is told nothing, because from
 *     their side nothing went wrong
 */
export function sendInBackground(message: EmailMessage, context: string): void {
  void sendEmail(message)
    .then((result) => {
      // Silent on success, loud on failure — the repo logs at warn and error
      // only, and a courtesy email arriving is not news. A failure is: it is
      // invisible from the user's side, so the server log is the only place
      // anyone will ever find out.
      if (!result.sent) {
        console.error(`[email] ${context} not sent to ${message.to}: ${result.reason}`);
      }
    })
    .catch((error: unknown) => {
      console.error(`[email] ${context} threw for ${message.to}:`, error);
    });
}
