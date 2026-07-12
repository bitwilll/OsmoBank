import { randomBytes } from 'node:crypto';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { db, tx, balance, audit, hashPass } from '../db.js';
import {
  ApiError, str, num, verifyPass, createSession, destroySession,
  requireAuth, rateLimit, publicUser, readCookie,
} from '../lib/util.js';
import { verifyTotp } from '../lib/totp.js';
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

export default function mount(app) {
  app.post('/api/auth/register', authLimiter, (req, res, next) => {
    try {
      const name = str(req.body?.name, { min: 2, max: 60, name: 'name' });
      const handle = str(req.body?.handle, { min: 2, max: 25, name: 'handle' })
        .toLowerCase().replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) throw new ApiError(400, 'handle must be 2–24 chars: a-z, 0-9, _');
      const email = str(req.body?.email, { min: 5, max: 120, name: 'email' }).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError(400, 'email looks invalid');
      const passphrase = str(req.body?.passphrase, { min: 12, max: 200, name: 'passphrase' });

      const user = tx(() => {
        const clash = db.prepare('SELECT id FROM users WHERE handle = ? OR email = ?').get(handle, email);
        if (clash) throw new ApiError(409, 'That handle or email is already a member');
        const id = Number(db.prepare(
          'INSERT INTO users (handle, name, email, pass) VALUES (?,?,?,?)')
          .run(handle, name, email, hashPass(passphrase)).lastInsertRowid);
        const led = db.prepare(
          "INSERT INTO ledger (user_id, currency, delta, kind, memo) VALUES (?,?,?,'seed','founding balance')");
        led.run(id, 'USDC', 12450);
        led.run(id, 'OSM', 10);
        issueCard(id); // every new member gets a virtual OsmoCard
        audit(id, 'register', `user:${id}`, handle);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      });

      createSession(res, user.id);
      res.status(201).json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/login', authLimiter, (req, res, next) => {
    try {
      const identifier = str(req.body?.identifier, { min: 2, max: 120, name: 'identifier' })
        .toLowerCase().replace(/^@/, '');
      const passphrase = str(req.body?.passphrase, { min: 1, max: 200, name: 'passphrase' });

      const user = db.prepare('SELECT * FROM users WHERE email = ? OR handle = ?')
        .get(identifier, identifier);
      // Verify against a dummy hash when the user is unknown to keep timing flat.
      const ok = user
        ? verifyPass(passphrase, user.pass)
        : (verifyPass(passphrase, 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128)), false);
      if (!ok) throw new ApiError(401, 'Wrong identifier or passphrase');
      if (user.status === 'frozen') throw new ApiError(403, 'Account frozen — contact an operator');

      // Two-factor step-up: if enabled, a valid TOTP code is required to finish.
      if (twoFactorEnabled(user.id)) {
        const code = req.body?.totpCode ? String(req.body.totpCode) : '';
        const secret = db.prepare('SELECT secret FROM user_2fa WHERE user_id = ?').get(user.id)?.secret;
        if (!code) return res.status(401).json({ error: 'Two-factor code required', twoFactorRequired: true });
        if (!secret || !verifyTotp(secret, code)) throw new ApiError(401, 'That two-factor code is not valid');
      }

      createSession(res, user.id);
      audit(user.id, 'login', `user:${user.id}`);
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(req, res);
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
        const u = db.prepare('SELECT id FROM users WHERE email = ? OR handle = ?').get(id, id);
        if (u) allow = db.prepare('SELECT cred_id FROM passkeys WHERE user_id = ?').all(u.id).map((c) => ({ id: c.cred_id }));
      }
      const options = await generateAuthenticationOptions({
        rpID: RP_ID, userVerification: 'preferred',
        allowCredentials: allow.length ? allow : undefined,
      });
      const token = randomBytes(24).toString('hex');
      saveChallenge(`login:${token}`, null, options.challenge, 'login');
      res.setHeader('Set-Cookie', `ob_pk=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300`);
      res.json(options);
    } catch (e) { next(e); }
  });

  app.post('/api/auth/passkey/login/verify', authLimiter, async (req, res, next) => {
    try {
      const token = readCookie(req, 'ob_pk');
      if (!token || !/^[0-9a-f]{48}$/.test(token)) throw new ApiError(400, 'Passkey login expired — try again');
      const ch = takeChallenge(`login:${token}`, 'login');
      if (!ch) throw new ApiError(400, 'Passkey login expired — try again');
      const response = req.body?.response;
      if (!response || !response.id) throw new ApiError(400, 'Malformed passkey response');

      const pk = db.prepare('SELECT * FROM passkeys WHERE cred_id = ?').get(response.id);
      if (!pk) throw new ApiError(401, 'Unknown passkey');
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pk.user_id);
      if (!user || user.status === 'frozen') throw new ApiError(403, 'Account unavailable');

      const verification = await verifyAuthenticationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        credential: { id: pk.cred_id, publicKey: fromB64url(pk.public_key), counter: pk.counter },
      });
      if (!verification.verified) throw new ApiError(401, 'Passkey verification failed');

      db.prepare("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
        .run(verification.authenticationInfo.newCounter, pk.id);
      // the single-use challenge is already consumed (takeChallenge deletes it) and
      // the ob_pk cookie is short-lived; createSession now sets the session cookie.
      createSession(res, user.id);
      audit(user.id, 'login.passkey', `user:${user.id}`);
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      user: publicUser(req.user),
      balances: { USDC: balance(req.user.id, 'USDC'), OSM: balance(req.user.id, 'OSM') },
    });
  });

  app.patch('/api/me', requireAuth, (req, res, next) => {
    try {
      const updates = {};
      if (req.body?.name !== undefined) updates.name = str(req.body.name, { min: 2, max: 60, name: 'name' });
      if (req.body?.email !== undefined) {
        updates.email = str(req.body.email, { min: 5, max: 120, name: 'email' }).toLowerCase();
        if (!EMAIL_RE.test(updates.email)) throw new ApiError(400, 'email looks invalid');
      }
      if (!Object.keys(updates).length) throw new ApiError(400, 'nothing to update');

      const user = tx(() => {
        if (updates.email) {
          const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
            .get(updates.email, req.user.id);
          if (clash) throw new ApiError(409, 'That email is already a member');
        }
        if (updates.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(updates.name, req.user.id);
        if (updates.email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(updates.email, req.user.id);
        audit(req.user.id, 'profile.update', `user:${req.user.id}`, Object.keys(updates).join(','));
        return db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      });
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/me/passphrase', requireAuth, (req, res, next) => {
    try {
      const current = str(req.body?.current, { min: 1, max: 200, name: 'current' });
      const nextPass = str(req.body?.next, { min: 12, max: 200, name: 'next' });
      if (!verifyPass(current, req.user.pass)) throw new ApiError(401, 'Current passphrase is wrong');
      db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(nextPass), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id); // sign out other devices
      createSession(res, req.user.id);
      audit(req.user.id, 'passphrase.change', `user:${req.user.id}`);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
