/**
 * The password reset email (Phase 20).
 *
 * Built the same way as the welcome email and for the same reasons — nested
 * tables, every style inline, a bgcolor-painted button, a plain-text part that
 * stands on its own (see `welcome.ts` for the long version). It is much
 * shorter, because it has one job: get the person to a working link, and tell
 * somebody who did not ask for it that they can ignore it.
 */
import { escapeHtml, wrap, type RenderedEmail } from './welcome';

const INDIGO = '#4f46e5';
const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const PAGE = '#f4f4f7';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface PasswordResetEmailInput {
  name?: string | null;
  /** The full link, token included. */
  resetUrl: string;
  /** How long the link works for, stated in the email so nobody is surprised. */
  ttlMinutes: number;
}

export function renderPasswordResetEmail({
  name,
  resetUrl,
  ttlMinutes,
}: PasswordResetEmailInput): RenderedEmail {
  const first = name?.trim().split(/\s+/)[0];
  const hello = first ? `Hi ${first},` : 'Hi,';
  const url = escapeHtml(resetUrl);
  const lifetime =
    ttlMinutes % 60 === 0
      ? `${ttlMinutes / 60} hour${ttlMinutes === 60 ? '' : 's'}`
      : `${ttlMinutes} minutes`;

  // Plain and specific. "Reset your password" is what every legitimate
  // service says, which is exactly why filters do not hold it against one.
  const subject = 'Reset your FinTrack password';

  const intro = `Somebody asked to reset the password for this FinTrack account. If it was you, choose a new one below. The link works once, for the next ${lifetime}.`;
  const ignore =
    'If you did not ask for this, you can ignore this email: your password has not changed, and nobody can change it without this link.';

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>Reset your FinTrack password</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE};">
    A link to choose a new password. It works once, for the next ${lifetime}.
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:${PAGE};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;"><tr><td><![endif]-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td bgcolor="${INDIGO}" style="background-color:${INDIGO};padding:24px 32px;">
              <p style="margin:0;font-family:${FONT};font-size:22px;line-height:28px;font-weight:800;color:#ffffff;">FinTrack</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <p style="margin:0 0 12px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${INK};">${escapeHtml(hello)}</p>
              <p style="margin:0;font-family:${FONT};font-size:16px;line-height:24px;color:${MUTED};">${escapeHtml(intro)}</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                <tr>
                  <td align="center" bgcolor="${INDIGO}" style="background-color:${INDIGO};border-radius:8px;">
                    <a href="${url}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Choose a new password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:14px 0 0 0;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Or paste this into your browser:<br /><a href="${url}" target="_blank" style="color:${INDIGO};text-decoration:underline;word-break:break-all;">${url}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 32px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr><td style="padding:0 0 20px 0;border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td></tr>
                <tr>
                  <td style="padding:0;font-family:${FONT};font-size:14px;line-height:21px;color:${MUTED};">${escapeHtml(ignore)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    hello,
    '',
    ...wrap(intro, 72),
    '',
    'Choose a new password:',
    resetUrl,
    '',
    ...wrap(ignore, 72),
    '',
    '--',
    'FinTrack',
  ].join('\n');

  return { subject, html, text };
}
