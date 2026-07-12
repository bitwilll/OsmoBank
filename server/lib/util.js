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

export function setSessionCookie(res, token, clear = false) {
  const parts = [
    `ob_sess=${clear ? '' : token}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function destroySession(req, res) {
  const token = readCookie(req, 'ob_sess');
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
  const token = readCookie(req, 'ob_sess');
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
