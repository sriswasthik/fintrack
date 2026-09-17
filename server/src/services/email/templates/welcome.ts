/**
 * The welcome email, sent once, on the day an account is created.
 *
 * Written as tables with every style inline, which looks like 2005 and is not
 * nostalgia. Gmail strips `<style>` blocks from the head, Outlook renders
 * through Word's HTML engine, and neither has a usable box model — so the
 * layout is nested tables, the spacing is cell padding, and every rule lives in
 * a `style` attribute on the element it applies to. An external stylesheet
 * would simply not arrive.
 *
 * Two details that are deliberate rather than decorative:
 *
 *   * The gradient header carries `bgcolor` **and** a `background-image`. A
 *     client that understands gradients draws one; Outlook ignores it and shows
 *     the solid colour underneath, which is why the solid is a mid-tone of the
 *     gradient rather than white.
 *   * The card is `width="100%"` capped by `max-width:600px`, not a fixed 600.
 *     A pinned 600px table overflows a 390px phone screen sideways, and phones
 *     are where most mail is read. Outlook ignores `max-width`, so it gets a
 *     600px wrapper of its own inside an `[if mso]` conditional — which is
 *     still self-contained markup, just addressed to one renderer.
 *   * Every block is a table row, not a flex child. There are no media
 *     queries: Gmail's Android client strips `<style>` blocks, so a layout
 *     that needs one is a layout that breaks there.
 *
 * The plain-text version below is the same message, not a stub. It is what a
 * text-only client shows, what a screen reader may prefer, and — since a
 * message with no text part is itself a spam signal — part of arriving at all.
 */

/** Brand colours, named once so the two halves cannot drift. */
const INDIGO = '#4f46e5';
const VIOLET = '#7c3aed';
/** The solid a gradient-blind client falls back to: a mid-tone of the two. */
const HEADER_SOLID = '#5b21b6';
const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const PAGE = '#f4f4f7';

export interface WelcomeEmailInput {
  /** Their name, if we have one. Google gives us one; registration may not. */
  name?: string | null;
  /** Where the CTA points — the app's login page. */
  appUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** What the email promises the product does. Shared by both renderings. */
const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    // A bank, not a flag: Windows ships no regional-indicator glyphs, so 🇮🇳
    // renders there as the bare letters "IN".
    icon: '🏦',
    title: 'Built for Indian statements',
    body: 'Import a PDF from SBI, HDFC or a UPI app like PhonePe. FinTrack reads each one on its own terms — and shows every amount in rupees, grouped the way you actually read them.',
  },
  {
    icon: '🏷️',
    title: 'Categorised before you look',
    body: 'Swiggy is dinner, BESCOM is a bill, an SIP is savings. Hundreds of built-in rules sort your transactions the moment they land, and anything genuinely ambiguous waits for you rather than being guessed at.',
  },
  {
    icon: '📊',
    title: 'A dashboard that answers questions',
    body: 'Where the month went, what changed since last month, and which merchants take the most. Click any number to see the exact transactions behind it.',
  },
  {
    icon: '🔎',
    title: 'Insights you did not ask for',
    body: 'A subscription that quietly went up. A category spending twice its usual. A charge that looks like a duplicate. FinTrack flags them and explains why.',
  },
];

/** A first name to greet, or nothing. */
function greeting(name?: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Welcome, ${first}` : 'Welcome to FinTrack';
}

/**
 * HTML-escapes a value going into the markup.
 *
 * The name comes from a registration form or a Google profile, so it is user
 * input arriving in a document — and an email client is a HTML renderer like
 * any other.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One feature block, as its own table row. */
function featureRow({ icon, title, body }: (typeof FEATURES)[number], last: boolean): string {
  return `
              <tr>
                <td style="padding:0 0 ${last ? '4px' : '22px'} 0;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                    <tr>
                      <td width="44" valign="top" style="width:44px;padding:0;font-size:24px;line-height:28px;">${icon}</td>
                      <td valign="top" style="padding:0;">
                        <p style="margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:22px;font-weight:700;color:${INK};">${title}</p>
                        <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:${MUTED};">${body}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`;
}

/**
 * Renders the welcome email.
 *
 * The subject is energetic without being a spam trigger: no ALL-CAPS, no
 * exclamation pile-up, no "FREE" or "ACT NOW", no emoji in the subject line
 * itself. Filters weight those heavily, and an email that does not arrive is
 * not a well-designed email.
 */
export function renderWelcomeEmail({ name, appUrl }: WelcomeEmailInput): RenderedEmail {
  const hello = escapeHtml(greeting(name));
  const loginUrl = `${appUrl.replace(/\/+$/, '')}/login`;
  const safeLoginUrl = escapeHtml(loginUrl);

  const subject = 'Welcome to FinTrack — your money, finally organised';

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>Welcome to FinTrack</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
  <!-- Preheader: the line a client shows beside the subject. Hidden in the
       body itself, so it does not appear twice. -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE};">
    Import a statement, and FinTrack sorts the rest. Here is what it can do.
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:${PAGE};">
    <tr>
      <td align="center" style="padding:24px 12px;">

        <!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;"><tr><td><![endif]-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#ffffff;border-radius:12px;overflow:hidden;">

          <!-- Header. bgcolor is the fallback a gradient-blind client keeps. -->
          <tr>
            <td bgcolor="${HEADER_SOLID}" style="background-color:${HEADER_SOLID};background-image:linear-gradient(135deg, ${INDIGO} 0%, ${VIOLET} 55%, #db2777 100%);padding:40px 32px;text-align:center;">
              <p style="margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:30px;line-height:36px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">FinTrack</p>
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#ede9fe;">Personal finance that reads Indian statements</p>
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td style="padding:34px 32px 8px 32px;">
              <h1 style="margin:0 0 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:25px;line-height:32px;font-weight:800;color:${INK};">${hello} 👋</h1>
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:${MUTED};">Your account is ready. Import one statement and FinTrack does the tedious part — sorting every transaction, adding up the month, and telling you what changed.</p>
            </td>
          </tr>

          <!-- Features -->
          <tr>
            <td style="padding:26px 32px 6px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
${FEATURES.map((feature, i) => featureRow(feature, i === FEATURES.length - 1)).join('')}
              </table>
            </td>
          </tr>

          <!-- Call to action. The table is the button: a styled <a> alone is
               unreliable in Outlook, which needs a cell to paint. -->
          <tr>
            <td align="center" style="padding:28px 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                <tr>
                  <td align="center" bgcolor="${INDIGO}" style="background-color:${INDIGO};border-radius:8px;">
                    <a href="${safeLoginUrl}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Open FinTrack</a>
                  </td>
                </tr>
              </table>
              <p style="margin:14px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};">Or paste this into your browser:<br /><a href="${safeLoginUrl}" target="_blank" style="color:${INDIGO};text-decoration:underline;">${safeLoginUrl}</a></p>
            </td>
          </tr>

          <!-- Signoff -->
          <tr>
            <td style="padding:24px 32px 32px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr><td style="padding:0 0 20px 0;border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td></tr>
                <tr>
                  <td style="padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:${MUTED};">
                    Glad you are here — I hope it saves you an evening a month.<br />
                    <span style="color:${INK};font-weight:600;">The FinTrack team</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->

        <!-- Footer, outside the card -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;border-collapse:collapse;">
          <tr>
            <td style="padding:18px 32px 8px 32px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#9ca3af;">
              You are getting this because an account was just created with this address at FinTrack.<br />
              This is the only message we send on signup.
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    greeting(name),
    '',
    'Your account is ready. Import one statement and FinTrack does the tedious',
    'part - sorting every transaction, adding up the month, and telling you what',
    'changed.',
    '',
    ...FEATURES.flatMap((feature) => [
      `* ${feature.title}`,
      ...wrap(feature.body, 72).map((line) => `  ${line}`),
      '',
    ]),
    'Open FinTrack:',
    loginUrl,
    '',
    'Glad you are here - I hope it saves you an evening a month.',
    'The FinTrack team',
    '',
    '--',
    'You are getting this because an account was just created with this address',
    'at FinTrack. This is the only message we send on signup.',
  ].join('\n');

  return { subject, html, text };
}

/** Wraps at a width a plain-text mail client will not re-flow badly. */
function wrap(body: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of body.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
