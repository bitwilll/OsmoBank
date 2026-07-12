import { db, tx, balance, audit, hashPass } from '../db.js';
import {
  ApiError, str, num, verifyPass, createSession, destroySession,
  requireAuth, rateLimit, publicUser,
} from '../lib/util.js';

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

      createSession(res, user.id);
      audit(user.id, 'login', `user:${user.id}`);
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
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
