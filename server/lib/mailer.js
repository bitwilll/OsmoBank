/* Transactional email for OsmoBank (currently: password-reset links).
 *
 * Provider-agnostic: it speaks standard SMTP (see ./smtp.js), so it delivers to
 * ANY recipient (gmail.com, hotmail.com, yahoo.com, company domains…) and can
 * send THROUGH any provider's relay. Configure via environment:
 *
 *   SMTP_SERVICE = gmail | outlook | hotmail | office365 | yahoo | icloud |
 *                  zoho | fastmail | sendgrid | mailgun | ses   (optional preset)
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE(true|false), SMTP_REQUIRE_TLS(true|false)
 *   SMTP_USER, SMTP_PASS            (SMTP_HOST/PORT override any preset)
 *   MAIL_FROM  = "OsmoBank <no-reply@yourdomain>"   (defaults to SMTP_USER)
 *
 * If nothing is configured, sending is a no-op that reports { delivered:false }.
 * For Gmail/Yahoo/iCloud use an app-specific password, not the account password. */
import { sendSmtp } from './smtp.js';

// host/port/secure defaults for common relays. secure=true → implicit TLS (:465);
// otherwise STARTTLS on submission port :587.
const SERVICES = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  googlemail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true },
  hotmail: { host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true },
  live: { host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true },
  office365: { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  icloud: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
  zoho: { host: 'smtp.zoho.com', port: 465, secure: true },
  fastmail: { host: 'smtp.fastmail.com', port: 465, secure: true },
  sendgrid: { host: 'smtp.sendgrid.net', port: 587, secure: false, requireTLS: true },
  mailgun: { host: 'smtp.mailgun.org', port: 587, secure: false, requireTLS: true },
  ses: { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, requireTLS: true },
  postmark: { host: 'smtp.postmarkapp.com', port: 587, secure: false, requireTLS: true },
};

const bool = (v, dflt) => (v == null || v === '' ? dflt : /^(1|true|yes)$/i.test(v));

/** Resolve SMTP config from env, or null when unconfigured. */
export function mailConfig(env = process.env) {
  const preset = SERVICES[String(env.SMTP_SERVICE || '').toLowerCase()] || {};
  const host = env.SMTP_HOST || preset.host;
  if (!host) return null;
  const port = Number(env.SMTP_PORT || preset.port || 587);
  const secure = bool(env.SMTP_SECURE, preset.secure ?? port === 465);
  const requireTLS = bool(env.SMTP_REQUIRE_TLS, preset.requireTLS ?? !secure);
  const user = env.SMTP_USER || undefined;
  const pass = env.SMTP_PASS || undefined;
  return {
    host, port, secure, requireTLS,
    auth: user && pass ? { user, pass } : null,
    from: env.MAIL_FROM || user || 'no-reply@osmo.money',
  };
}

export const mailerConfigured = (env = process.env) => !!mailConfig(env);

const stripHeader = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// RFC 2047 encode a subject only if it has non-ASCII (keeps ASCII subjects clean).
const encodeSubject = (s) => (/[^\x20-\x7e]/.test(s)
  ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
  : s);

/** Serialise a multipart/alternative (text + html) RFC 5322 message. */
function buildMime({ from, to, subject, text, html, date, messageId }) {
  const boundary = `=_osmo_${Buffer.from(String(messageId)).toString('hex').slice(0, 24)}`;
  const headers = [
    `From: ${stripHeader(from)}`,
    `To: ${stripHeader(to)}`,
    `Subject: ${encodeSubject(stripHeader(subject))}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}--`,
    '',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + body.join('\r\n');
}

/** Low-level send. Returns {delivered:false, reason} instead of throwing when unconfigured. */
export async function sendMail({ to, subject, text, html }, env = process.env) {
  const cfg = mailConfig(env);
  if (!cfg) return { delivered: false, reason: 'smtp-not-configured' };
  const recipient = stripHeader(to);
  const raw = buildMime({
    from: cfg.from, to: recipient, subject, text, html,
    date: new Date().toUTCString(),
    messageId: `${Date.now()}.${Math.random().toString(36).slice(2)}@osmo.money`,
  });
  await sendSmtp({ ...cfg, to: recipient, raw });
  return { delivered: true };
}

/** Send the password-reset email carrying a single-use link. */
export function sendResetEmail(to, link, env = process.env) {
  const subject = 'Reset your OsmoBank passphrase';
  const text = [
    'We received a request to reset your OsmoBank passphrase.',
    '',
    'Open this link to choose a new one (it expires in 30 minutes and can be used once):',
    link,
    '',
    "If you didn't request this, you can safely ignore this email — your passphrase stays the same.",
    '',
    '— OsmoBank',
  ].join('\n');
  const safe = escapeHtml(link);
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0a0a0a">
  <h2 style="font-weight:800;letter-spacing:-.01em">Reset your passphrase</h2>
  <p style="line-height:1.6;color:#3a3a3a">We received a request to reset your OsmoBank passphrase. Choose a new one with the button below. This link <b>expires in 30 minutes</b> and can be used once.</p>
  <p style="margin:24px 0"><a href="${safe}" style="background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 22px;border-radius:100px;font-weight:600;display:inline-block">Choose a new passphrase</a></p>
  <p style="line-height:1.6;color:#757575;font-size:13px">Or paste this into your browser:<br><span style="word-break:break-all">${safe}</span></p>
  <p style="line-height:1.6;color:#757575;font-size:13px">If you didn't request this, you can safely ignore this email — your passphrase won't change.</p>
  <p style="color:#a3a3a3;font-size:12px;border-top:1px solid #eee;padding-top:14px">OsmoBank · member-owned</p>
</div>`;
  return sendMail({ to, subject, text, html }, env);
}
