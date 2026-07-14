/* Account security: TOTP two-factor + WebAuthn passkeys.
 * - TOTP: RFC 6238, verified server-side (server/lib/totp.js).
 * - Passkeys: real WebAuthn via @simplewebauthn/server. Registration lives here
 *   (authenticated); passkey LOGIN lives in auth.js (pre-auth). rpID/origin are
 *   env-configurable and default to localhost for dev. */
import {
  generateRegistrationOptions, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { db, audit } from '../db.js';
import { ApiError, str, requireAuth, verifyPass, assertNotLocked, recordFail, clearFails } from '../lib/util.js';
import { generateSecret, verifyTotp, otpauthUri } from '../lib/totp.js';

export const RP_ID = process.env.OSMO_RP_ID || 'localhost';
export const RP_NAME = 'OsmoBank';
export const ORIGIN = process.env.OSMO_ORIGIN || `http://localhost:${process.env.PORT || 8471}`;

const b64url = (u8) => Buffer.from(u8).toString('base64url');
const fromB64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

export async function twoFactorEnabled(userId) {
  const row = await db.prepare('SELECT enabled FROM user_2fa WHERE user_id = ?').get(userId);
  return !!(row && row.enabled);
}

export async function saveChallenge(id, userId, challenge, purpose) {
  await db.prepare("INSERT OR REPLACE INTO webauthn_challenges (id, user_id, challenge, purpose, expires_at) VALUES (?,?,?,?,datetime('now','+5 minutes'))")
    .run(id, userId ?? null, challenge, purpose);
}
export async function takeChallenge(id, purpose) {
  const row = await db.prepare("SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = ? AND expires_at > datetime('now')").get(id, purpose);
  if (row) await db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
  return row || null;
}

async function securityStatus(userId) {
  const passkeys = (await db.prepare('SELECT id, label, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id DESC').all(userId))
    .map((p) => ({ id: p.id, label: p.label || 'Passkey', createdAt: p.created_at, lastUsedAt: p.last_used_at }));
  const pending = await db.prepare('SELECT enabled FROM user_2fa WHERE user_id = ?').get(userId);
  return { twoFactorEnabled: !!(pending && pending.enabled), twoFactorPending: !!(pending && !pending.enabled), passkeys };
}

export default function mount(app) {
  app.get('/api/security', requireAuth, async (req, res) => res.json(await securityStatus(req.user.id)));

  // ---- TOTP two-factor -----------------------------------------------------
  app.post('/api/security/2fa/setup', requireAuth, async (req, res, next) => {
    try {
      if (await twoFactorEnabled(req.user.id)) throw new ApiError(409, 'Two-factor is already enabled');
      const secret = generateSecret();
      await db.prepare("INSERT OR REPLACE INTO user_2fa (user_id, secret, enabled) VALUES (?,?,0)").run(req.user.id, secret);
      res.json({ secret, otpauthUri: otpauthUri(secret, req.user.email) });
    } catch (e) { next(e); }
  });

  app.post('/api/security/2fa/enable', requireAuth, async (req, res, next) => {
    try {
      const lockKey = `2fa-enable:${req.user.id}`;
      assertNotLocked(lockKey);
      const code = str(req.body?.code, { min: 6, max: 6, name: 'code' });
      const row = await db.prepare('SELECT secret, enabled FROM user_2fa WHERE user_id = ?').get(req.user.id);
      if (!row) throw new ApiError(400, 'Start 2FA setup first');
      if (row.enabled) throw new ApiError(409, 'Two-factor is already enabled');
      if (!verifyTotp(row.secret, code)) { recordFail(lockKey); throw new ApiError(401, 'That code is not valid — check your authenticator'); }
      clearFails(lockKey);
      await db.prepare('UPDATE user_2fa SET enabled = 1 WHERE user_id = ?').run(req.user.id);
      await audit(req.user.id, '2fa.enable', `user:${req.user.id}`);
      res.json({ ok: true, ...(await securityStatus(req.user.id)) });
    } catch (e) { next(e); }
  });

  app.post('/api/security/2fa/disable', requireAuth, async (req, res, next) => {
    try {
      // Require re-auth: a valid current TOTP code OR the account passphrase.
      // Throttle so a session-only attacker cannot brute-force the rotating
      // 6-digit code (or the passphrase) to tear down 2FA. Uses the shared
      // per-account re-auth lock so guesses can't be spread across the reveal /
      // disable / passphrase-change endpoints to multiply the attempt budget.
      const lockKey = `reauth:${req.user.id}`;
      assertNotLocked(lockKey);
      const row = await db.prepare('SELECT secret, enabled FROM user_2fa WHERE user_id = ?').get(req.user.id);
      if (!row || !row.enabled) throw new ApiError(400, 'Two-factor is not enabled');
      const code = req.body?.code ? String(req.body.code) : '';
      const pass = req.body?.passphrase ? String(req.body.passphrase) : '';
      const ok = (code && verifyTotp(row.secret, code)) || (pass && verifyPass(pass, req.user.pass));
      if (!ok) { recordFail(lockKey); throw new ApiError(401, 'Enter a current code or your passphrase to disable 2FA'); }
      clearFails(lockKey);
      await db.prepare('DELETE FROM user_2fa WHERE user_id = ?').run(req.user.id);
      await audit(req.user.id, '2fa.disable', `user:${req.user.id}`);
      res.json({ ok: true, ...(await securityStatus(req.user.id)) });
    } catch (e) { next(e); }
  });

  // ---- WebAuthn passkey registration --------------------------------------
  app.post('/api/security/passkey/register/options', requireAuth, async (req, res, next) => {
    try {
      const existing = await db.prepare('SELECT cred_id FROM passkeys WHERE user_id = ?').all(req.user.id);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID,
        userName: req.user.email, userID: new TextEncoder().encode(String(req.user.id)),
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.cred_id })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      await saveChallenge(`reg:${req.user.id}`, req.user.id, options.challenge, 'register');
      res.json(options);
    } catch (e) { next(e); }
  });

  app.post('/api/security/passkey/register/verify', requireAuth, async (req, res, next) => {
    try {
      const ch = await takeChallenge(`reg:${req.user.id}`, 'register');
      if (!ch) throw new ApiError(400, 'Registration expired — start again');
      const label = req.body?.label ? str(req.body.label, { min: 1, max: 40, name: 'label' }) : 'Passkey';
      const verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: ch.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      });
      if (!verification.verified || !verification.registrationInfo) throw new ApiError(400, 'Passkey could not be verified');
      const cred = verification.registrationInfo.credential;
      await db.prepare('INSERT INTO passkeys (user_id, cred_id, public_key, counter, transports, label) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, cred.id, b64url(cred.publicKey), cred.counter || 0,
          (cred.transports || []).join(','), label);
      await audit(req.user.id, 'passkey.add', `user:${req.user.id}`, label);
      res.status(201).json({ ok: true, ...(await securityStatus(req.user.id)) });
    } catch (e) { next(e); }
  });

  app.delete('/api/security/passkey/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const pk = await db.prepare('SELECT id FROM passkeys WHERE id = ? AND user_id = ?').get(id, req.user.id);
      if (!pk) throw new ApiError(404, 'Passkey not found');
      await db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
      await audit(req.user.id, 'passkey.remove', `passkey:${id}`);
      res.json({ ok: true, ...(await securityStatus(req.user.id)) });
    } catch (e) { next(e); }
  });
}

// helpers used by auth.js for passkey LOGIN
export { b64url, fromB64url };
