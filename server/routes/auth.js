import { randomBytes } from 'node:crypto';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { db, tx, balance, audit, hashPass } from '../db.js';
import {
  ApiError, str, num, verifyPass, createSession, destroySession,
  requireAuth, rateLimit, publicUser, readCookie, cookieString, appendCookie, PK_COOKIE,
  assertNotLocked, recordFail, clearFails,
  sha256hex, sessionStatus, listSessions, revokeOtherSessions, revokeAllSessions,
  clientMeta, SECURE_COOKIES,
} from '../lib/util.js';
import { verifyMessage } from 'ethers';
import { verifyTotp } from '../lib/totp.js';
import { sendResetEmail, mailerConfigured } from '../lib/mailer.js';
import { raiseTicket } from './support.js';
import {
  twoFactorEnabled, saveChallenge, takeChallenge, b64url, fromB64url, RP_ID, ORIGIN,
} from './security.js';
import { issueCard } from './cards.js';

const HANDLE_RE = /^[a-z0-9_]{2,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Shared limiter for auth endpoints. NOTE: registration returns 201-vs-409, which
// can confirm whether an email/handle already exists (a low-severity enumeration
// leak flagged in the security audit). A hard fix requires an email-verification
// flow (create-on-confirm) so the response never reveals existence — out of scope
// without mail infrastructure. The rate limit below caps how fast an unauthenticated
// caller can probe; a much tighter cap was rejected because it would also block
// legitimate signups behind shared NAT/corporate IPs. Documented as accepted risk.
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// Password-reset tokens are single-use and short-lived. Only their SHA-256 hash
// is persisted (see password_resets), so a DB leak yields no usable link.
const RESET_TTL_MIN = 30;
// Minimum gap between reset issuances per account. Bounds reset-email spam and
// stops an attacker from repeatedly invalidating a victim's live token.
const RESET_COOLDOWN_SEC = 60;
// In production (Secure cookies / HTTPS) the forgot endpoint returns an identical
// generic response whether or not the account exists — the token is delivered out
// of band (email). Locally there is no mail server, so DEV_REVEAL surfaces the
// token to the browser flow. This branch is impossible in production.
const DEV_REVEAL = !SECURE_COOKIES;
// Light per-account limiter for authenticated session actions (defence-in-depth
// against audit-log growth / griefing; the real guards are auth + CSRF checks).
const sessionLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, key: (req) => `sess:${req.user?.id || req.ip}` });

// Mint a single-use reset token for a caller who has ALREADY proven ownership
// (card details or a seed-phrase signature). Safe to hand the raw token back —
// unlike the email flow, the proof authenticates the requester.
async function issueRecoveryReset(userId, req, method) {
  const token = randomBytes(32).toString('base64url');
  const { ip } = clientMeta(req);
  await db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?,?,datetime('now', ?),?)")
    .run(userId, sha256hex(token), `+${RESET_TTL_MIN} minutes`, ip);
  await audit(userId, 'passphrase.recover', `user:${userId}`, method);
  return token;
}

export default function mount(app) {
  app.post('/api/auth/register', authLimiter, async (req, res, next) => {
    try {
      const name = str(req.body?.name, { min: 2, max: 60, name: 'name' });
      const handle = str(req.body?.handle, { min: 2, max: 25, name: 'handle' })
        .toLowerCase().replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) throw new ApiError(400, 'handle must be 2–24 chars: a-z, 0-9, _');
      const email = str(req.body?.email, { min: 5, max: 120, name: 'email' }).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError(400, 'email looks invalid');
      const passphrase = str(req.body?.passphrase, { min: 12, max: 200, name: 'passphrase' });
      // Membership requires explicit acceptance of the legal notice (OsmoBank is
      // not a bank; funds are not insured). The client blocks too, but the server
      // is the authority — acceptance is recorded in the audit log.
      if (req.body?.disclaimerAccepted !== true) {
        throw new ApiError(400, 'You must accept the legal notice to create an account');
      }

      const user = await tx(async () => {
        const clash = await db.prepare('SELECT id FROM users WHERE handle = ? OR email = ?').get(handle, email);
        if (clash) throw new ApiError(409, 'That handle or email is already a member');
        const id = Number((await db.prepare(
          'INSERT INTO users (handle, name, email, pass) VALUES (?,?,?,?)')
          .run(handle, name, email, hashPass(passphrase))).lastInsertRowid);
        // New members start with a genuine clean slate: zero balances, no demo
        // money. They fund the account themselves via Add Funds (deposit) or by
        // receiving crypto/an internal transfer.
        await issueCard(id); // every new member still gets their own (empty) virtual OsmoCard
        await audit(id, 'register', `user:${id}`, `${handle} · legal notice accepted`);
        return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      });

      await createSession(res, user.id, req);
      res.status(201).json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/login', authLimiter, async (req, res, next) => {
    try {
      const identifier = str(req.body?.identifier, { min: 2, max: 120, name: 'identifier' })
        .toLowerCase().replace(/^@/, '');
      const passphrase = str(req.body?.passphrase, { min: 1, max: 200, name: 'passphrase' });

      const user = await db.prepare('SELECT * FROM users WHERE email = ? OR handle = ?')
        .get(identifier, identifier);
      // Verify against a dummy hash when the user is unknown to keep timing flat.
      const ok = user
        ? verifyPass(passphrase, user.pass)
        : (verifyPass(passphrase, 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128)), false);
      if (!ok) throw new ApiError(401, 'Wrong identifier or passphrase');
      if (user.status === 'frozen') throw new ApiError(403, 'Account frozen — contact an operator');

      // Two-factor step-up: if enabled, a valid TOTP code is required to finish.
      if (await twoFactorEnabled(user.id)) {
        const lockKey = `2fa:${user.id}`;
        assertNotLocked(lockKey);
        const code = req.body?.totpCode ? String(req.body.totpCode) : '';
        const secret = (await db.prepare('SELECT secret FROM user_2fa WHERE user_id = ?').get(user.id))?.secret;
        if (!code) return res.status(401).json({ error: 'Two-factor code required', twoFactorRequired: true });
        if (!secret || !verifyTotp(secret, code)) { recordFail(lockKey); throw new ApiError(401, 'That two-factor code is not valid'); }
        clearFails(lockKey);
      }

      await createSession(res, user.id, req);
      await audit(user.id, 'login', `user:${user.id}`);
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/logout', async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  });

  // ---- passkey (WebAuthn) login -------------------------------------------
  app.post('/api/auth/passkey/login/options', authLimiter, async (req, res, next) => {
    try {
      // Optional identifier narrows allowCredentials; otherwise a discoverable
      // (resident) credential is used. We never reveal whether the user exists.
      let allow = [];
      if (req.body?.identifier) {
        const id = String(req.body.identifier).toLowerCase().replace(/^@/, '');
        const u = await db.prepare('SELECT id FROM users WHERE email = ? OR handle = ?').get(id, id);
        if (u) allow = (await db.prepare('SELECT cred_id FROM passkeys WHERE user_id = ?').all(u.id)).map((c) => ({ id: c.cred_id }));
      }
      const options = await generateAuthenticationOptions({
        rpID: RP_ID, userVerification: 'preferred',
        allowCredentials: allow.length ? allow : undefined,
      });
      const token = randomBytes(24).toString('hex');
      await saveChallenge(`login:${token}`, null, options.challenge, 'login');
      appendCookie(res, cookieString(PK_COOKIE, token, { maxAge: 300 }));
      res.json(options);
    } catch (e) { next(e); }
  });

  app.post('/api/auth/passkey/login/verify', authLimiter, async (req, res, next) => {
    try {
      const token = readCookie(req, PK_COOKIE);
      if (!token || !/^[0-9a-f]{48}$/.test(token)) throw new ApiError(400, 'Passkey login expired — try again');
      const ch = await takeChallenge(`login:${token}`, 'login');
      if (!ch) throw new ApiError(400, 'Passkey login expired — try again');
      const response = req.body?.response;
      if (!response || !response.id) throw new ApiError(400, 'Malformed passkey response');

      const pk = await db.prepare('SELECT * FROM passkeys WHERE cred_id = ?').get(response.id);
      if (!pk) throw new ApiError(401, 'Unknown passkey');
      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(pk.user_id);
      if (!user || user.status === 'frozen') throw new ApiError(403, 'Account unavailable');

      const verification = await verifyAuthenticationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        credential: { id: pk.cred_id, publicKey: fromB64url(pk.public_key), counter: pk.counter },
      });
      if (!verification.verified) throw new ApiError(401, 'Passkey verification failed');

      await db.prepare("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
        .run(verification.authenticationInfo.newCounter, pk.id);
      // the single-use challenge is already consumed (takeChallenge deletes it) and
      // the ob_pk cookie is short-lived; createSession now sets the session cookie.
      await createSession(res, user.id, req);
      await audit(user.id, 'login.passkey', `user:${user.id}`);
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.get('/api/me', requireAuth, async (req, res) => {
    res.json({
      user: publicUser(req.user),
      balances: { USDC: await balance(req.user.id, 'USDC'), OSM: await balance(req.user.id, 'OSM') },
      // Single-active-session signal for the landing page: how many *other*
      // sessions exist and how many are live (seen within the last 2 minutes).
      session: await sessionStatus(req.user.id, req.sessionToken),
    });
  });

  // ---- active sessions (security / "your devices") -------------------------
  app.get('/api/sessions', requireAuth, async (req, res) => {
    res.json({ sessions: await listSessions(req.user.id, req.sessionToken) });
  });

  // Sign out every *other* device, keeping this one. Used from the landing page
  // when a concurrent live session is detected, and from the security panel.
  app.post('/api/auth/logout-all', requireAuth, sessionLimiter, async (req, res) => {
    const revoked = await revokeOtherSessions(req.user.id, req.sessionToken);
    await audit(req.user.id, 'session.revoke_others', `user:${req.user.id}`, String(revoked));
    res.json({ ok: true, revoked });
  });

  app.patch('/api/me', requireAuth, async (req, res, next) => {
    try {
      const updates = {};
      if (req.body?.name !== undefined) updates.name = str(req.body.name, { min: 2, max: 60, name: 'name' });
      if (req.body?.email !== undefined) {
        updates.email = str(req.body.email, { min: 5, max: 120, name: 'email' }).toLowerCase();
        if (!EMAIL_RE.test(updates.email)) throw new ApiError(400, 'email looks invalid');
      }
      if (!Object.keys(updates).length) throw new ApiError(400, 'nothing to update');

      const user = await tx(async () => {
        if (updates.email) {
          const clash = await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
            .get(updates.email, req.user.id);
          if (clash) throw new ApiError(409, 'That email is already a member');
        }
        if (updates.name) await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(updates.name, req.user.id);
        if (updates.email) await db.prepare('UPDATE users SET email = ? WHERE id = ?').run(updates.email, req.user.id);
        await audit(req.user.id, 'profile.update', `user:${req.user.id}`, Object.keys(updates).join(','));
        return await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      });
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/me/passphrase', requireAuth, async (req, res, next) => {
    try {
      // Shared per-account re-auth lock (see security.js) so a session-only
      // attacker can't brute-force the current passphrase here — the same lock
      // covers card reveal and 2FA disable.
      const lockKey = `reauth:${req.user.id}`;
      assertNotLocked(lockKey);
      const current = str(req.body?.current, { min: 1, max: 200, name: 'current' });
      const nextPass = str(req.body?.next, { min: 12, max: 200, name: 'next' });
      if (!verifyPass(current, req.user.pass)) { recordFail(lockKey); throw new ApiError(401, 'Current passphrase is wrong'); }
      clearFails(lockKey);
      await db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(nextPass), req.user.id);
      await db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(req.user.id); // stale reset links can't survive a credential change
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id); // sign out other devices
      await createSession(res, req.user.id, req);
      await audit(req.user.id, 'passphrase.change', `user:${req.user.id}`);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- forgot / reset passphrase -------------------------------------------
  // Request a reset link. ALWAYS returns the same generic response so an
  // unauthenticated caller can't tell whether an account exists (no enumeration).
  app.post('/api/auth/forgot', authLimiter, async (req, res, next) => {
    try {
      const identifier = str(req.body?.identifier, { min: 2, max: 120, name: 'identifier' })
        .toLowerCase().replace(/^@/, '');
      const user = await db.prepare('SELECT id, handle, email FROM users WHERE email = ? OR handle = ?')
        .get(identifier, identifier);
      const out = { ok: true };
      if (user) {
        // Per-account cooldown: at most one reset per RESET_COOLDOWN_SEC. We do NOT
        // invalidate prior tokens on mint — each is single-use and short-lived, and
        // a completed reset / passphrase change clears all of a user's pending
        // tokens. This stops an attacker spamming forgot to kill a victim's live
        // token (targeted account-recovery DoS).
        const recent = await db.prepare(
          "SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > datetime('now', ?) LIMIT 1")
          .get(user.id, `-${RESET_COOLDOWN_SEC} seconds`);
        if (!recent) {
          const token = randomBytes(32).toString('base64url');
          const { ip } = clientMeta(req);
          await tx(async () => {
            await db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?,?,datetime('now', ?),?)")
              .run(user.id, sha256hex(token), `+${RESET_TTL_MIN} minutes`, ip);
            await audit(user.id, 'passphrase.reset.request', `user:${user.id}`);
            // Also notify an operator (in parallel with the email) so support has
            // visibility on every reset request.
            await raiseTicket({
              userId: user.id, email: user.email, handle: user.handle,
              category: 'password_reset', source: 'system',
              message: `Password-reset link requested for @${user.handle}.`,
            });
          });
          const link = `${ORIGIN}/#/reset?token=${token}`;
          // Deliver out of band via SMTP if configured. Fire-and-forget so response
          // timing can't signal account existence or whether delivery succeeded.
          if (mailerConfigured()) {
            sendResetEmail(user.email, link)
              .then((r) => console.log(r.delivered ? `[reset] emailed user:${user.id}` : `[reset] user:${user.id} not emailed (${r.reason})`))
              .catch((e) => console.error(`[reset] email to user:${user.id} failed: ${e.message}`));
          }
          if (DEV_REVEAL) {
            // Local dev convenience (no mail server needed): hand the token to the
            // in-browser flow and log the link.
            console.log(`[reset] @${user.handle} → ${link}`);
            out.devToken = token; out.devResetUrl = link;
          } else if (!mailerConfigured()) {
            // Production with no SMTP configured: never log the bearer token
            // (CWE-532) — just flag that delivery is unconfigured.
            console.log(`[reset] user:${user.id} — SMTP not configured; reset link not delivered`);
          }
        } else {
          await tx(async () => {}); // keep response timing flat when in cooldown
        }
      } else {
        // Flatten response timing so latency can't reveal whether the account
        // exists: match the existent path's dominant cost (a commit fsync).
        await tx(async () => {});
      }
      res.json(out);
    } catch (e) { next(e); }
  });

  // Complete a reset with the single-use token. Consumes the token, rotates the
  // passphrase, and revokes EVERY session (an attacker mid-hijack is kicked out).
  app.post('/api/auth/reset', authLimiter, async (req, res, next) => {
    try {
      const token = str(req.body?.token, { min: 16, max: 200, name: 'token' });
      const nextPass = str(req.body?.next, { min: 12, max: 200, name: 'passphrase' });
      const done = await tx(async () => {
        const row = await db.prepare(
          `SELECT * FROM password_resets
           WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`)
          .get(sha256hex(token));
        if (!row) throw new ApiError(400, 'This reset link is invalid or has expired');
        await db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(nextPass), row.user_id);
        // Consume the used token AND any sibling pending tokens for this user.
        await db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(row.user_id);
        await revokeAllSessions(row.user_id);
        await audit(row.user_id, 'passphrase.reset', `user:${row.user_id}`);
        return true;
      });
      // Deliberately do NOT sign the user in — they re-authenticate with the new
      // passphrase, proving possession of it.
      res.json({ ok: done });
    } catch (e) { next(e); }
  });

  // ---- self-service recovery (no email needed) -----------------------------
  // Prove ownership with an OsmoBank-issued card OR the wallet recovery phrase,
  // then receive a single-use reset token to set a new passphrase.

  // (a) Card credential: verify the full PAN + expiry + CVV against a stored card.
  app.post('/api/auth/recover/card', authLimiter, async (req, res, next) => {
    try {
      const identifier = str(req.body?.identifier, { min: 2, max: 120, name: 'identifier' }).toLowerCase().replace(/^@/, '');
      const pan = str(req.body?.pan, { min: 12, max: 25, name: 'card number' }).replace(/\D/g, '');
      const exp = str(req.body?.exp, { min: 4, max: 7, name: 'expiry' }).replace(/\s/g, '');
      const cvv = str(req.body?.cvv, { min: 3, max: 4, name: 'security code' }).replace(/\D/g, '');
      const lockKey = `recover:${identifier}`;
      assertNotLocked(lockKey);
      const bad = new ApiError(400, "Those card details don't match — check them and try again");
      const user = await db.prepare('SELECT id FROM users WHERE email = ? OR handle = ?').get(identifier, identifier);
      const cards = user
        ? await db.prepare('SELECT pan, cvv, exp_month, exp_year FROM cards WHERE user_id = ?').all(user.id)
        : [];
      const expOk = (c) => {
        const mm = String(c.exp_month).padStart(2, '0');
        const yy = String(c.exp_year).slice(-2);
        return exp === `${mm}/${yy}` || exp === `${mm}/${c.exp_year}` || exp === `${mm}${yy}`;
      };
      const match = cards.some((c) => c.pan === pan && String(c.cvv) === cvv && expOk(c));
      if (!user || !match) { recordFail(lockKey); throw bad; }
      clearFails(lockKey);
      res.json({ ok: true, resetToken: await issueRecoveryReset(user.id, req, 'card') });
    } catch (e) { next(e); }
  });

  // (b) Recovery phrase: challenge → the client signs the nonce with the wallet's
  // Ethereum key; we verify the signature recovers an address anchored to the
  // account. The mnemonic never leaves the member's device.
  app.post('/api/auth/recover/challenge', authLimiter, async (req, res, next) => {
    try {
      const nonce = randomBytes(24).toString('hex');
      await saveChallenge(`recover:${nonce}`, null, nonce, 'recover'); // single-use, 5-min TTL
      res.json({ nonce });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/recover/seed', authLimiter, async (req, res, next) => {
    try {
      const identifier = str(req.body?.identifier, { min: 2, max: 120, name: 'identifier' }).toLowerCase().replace(/^@/, '');
      const nonce = str(req.body?.nonce, { min: 16, max: 80, name: 'nonce' });
      const signature = str(req.body?.signature, { min: 100, max: 400, name: 'signature' });
      const lockKey = `recover:${identifier}`;
      assertNotLocked(lockKey);
      const ch = await takeChallenge(`recover:${nonce}`, 'recover'); // consume (single-use)
      if (!ch) throw new ApiError(400, 'Recovery challenge expired — start again');
      const bad = new ApiError(400, "That recovery phrase doesn't match this account");
      const user = await db.prepare('SELECT id FROM users WHERE email = ? OR handle = ?').get(identifier, identifier);
      const anchors = user
        ? (await db.prepare("SELECT LOWER(address) AS a FROM wallets WHERE user_id = ? AND chain = 'eth'").all(user.id)).map((r) => r.a)
        : [];
      let recovered = null;
      try { recovered = verifyMessage(nonce, signature).toLowerCase(); } catch { /* malformed signature */ }
      if (!user || !anchors.length || !recovered || !anchors.includes(recovered)) { recordFail(lockKey); throw bad; }
      clearFails(lockKey);
      res.json({ ok: true, resetToken: await issueRecoveryReset(user.id, req, 'seed') });
    } catch (e) { next(e); }
  });
}
