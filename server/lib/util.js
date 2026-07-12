import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- validation ----------------------------------------------------------
export function str(v, { min = 1, max = 200, name = 'value', pattern = null } = {}) {
  if (typeof v !== 'string') throw new ApiError(400, `${name} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new ApiError(400, `${name} must be ${min}–${max} characters`);
  if (pattern && !pattern.test(t)) throw new ApiError(400, `${name} has an invalid format`);
  return t;
}

export function num(v, { min = -Infinity, max = Infinity, name = 'value', int = false } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ApiError(400, `${name} must be a number`);
  if (int && !Number.isInteger(n)) throw new ApiError(400, `${name} must be an integer`);
  if (n < min || n > max) throw new ApiError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

export function oneOf(v, allowed, name = 'value') {
  if (!allowed.includes(v)) throw new ApiError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

export const round2 = (n) => Math.round(n * 100) / 100;

// ---- passwords -----------------------------------------------------------
export function verifyPass(passphrase, stored) {
  const [scheme, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(String(passphrase), salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---- sessions ------------------------------------------------------------
const SESSION_DAYS = 30;

export function createSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,datetime('now', ?))")
    .run(token, userId, `+${SESSION_DAYS} days`);
  setSessionCookie(res, token);
  return token;
}

// Over HTTPS (production) cookies carry the Secure flag and the __Host- prefix,
// which the browser only accepts on a Secure, Path=/, Domain-less cookie — this
// hard-binds the session cookie to this exact host and blocks plaintext/MITM
// theft and subdomain injection. In local HTTP dev, Secure would stop the
// browser sending the cookie at all, so it is dropped and the plain name is used.
export const SECURE_COOKIES = process.env.NODE_ENV === 'production' || process.env.OSMO_SECURE_COOKIES === '1';
export const SESS_COOKIE = SECURE_COOKIES ? '__Host-ob_sess' : 'ob_sess';
export const PK_COOKIE = SECURE_COOKIES ? '__Host-ob_pk' : 'ob_pk';

/** Build a Set-Cookie string with our standard hardening flags. */
export function cookieString(name, value, { maxAge, clear = false } = {}) {
  const parts = [`${name}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${maxAge}`);
  if (SECURE_COOKIES) parts.push('Secure');
  return parts.join('; ');
}

/** Append (not overwrite) a Set-Cookie header so several cookies can coexist. */
export function appendCookie(res, str) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, str) : str);
}

export function setSessionCookie(res, token, clear = false) {
  appendCookie(res, cookieString(SESS_COOKIE, token, { maxAge: SESSION_DAYS * 86400, clear }));
}

export function destroySession(req, res) {
  const token = readCookie(req, SESS_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setSessionCookie(res, '', true);
}

export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i > -1 && pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim();
  }
  return null;
}

export function publicUser(u) {
  return { id: u.id, name: u.name, handle: u.handle, email: u.email, role: u.role, status: u.status, createdAt: u.created_at };
}

/** Attach req.user when a valid session cookie is present (never rejects). */
export function loadSession(req, res, next) {
  const token = readCookie(req, SESS_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    const row = db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
    if (row) {
      if (row.status === 'frozen') {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        setSessionCookie(res, '', true);
      } else {
        req.user = row;
      }
    }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'Sign in required'));
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Sign in required'));
    if (!roles.includes(req.user.role)) return next(new ApiError(403, 'Not permitted'));
    next();
  };
}

// ---- rate limiting (fixed window, in-memory) ------------------------------
const buckets = new Map();
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  return (req, _res, next) => {
    const now = Date.now();
    const k = key(req);
    let b = buckets.get(k);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(k, b);
    }
    if (++b.count > max) return next(new ApiError(429, 'Too many requests — try again shortly'));
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60000).unref();

// ---- account lockout (brute-force defense for verification codes) ----------
// Per-key failure counter with an exponential-ish cooldown, so guessing a 6-digit
// TOTP or a card passphrase is throttled per account regardless of source IP.
const fails = new Map();
const LOCK_THRESHOLD = 6;      // consecutive failures before lockout
const LOCK_MS = 15 * 60 * 1000; // cooldown once locked

export function assertNotLocked(key) {
  const f = fails.get(key);
  if (f && f.until && Date.now() < f.until) {
    throw new ApiError(429, 'Too many attempts — locked for a few minutes');
  }
}
export function recordFail(key) {
  const f = fails.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= LOCK_THRESHOLD) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  fails.set(key, f);
}
export function clearFails(key) { fails.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of fails) if ((!f.until || now > f.until) && !f.count) fails.delete(k);
}, 5 * 60 * 1000).unref();
