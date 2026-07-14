import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from '../db.js';

/** SHA-256 hex — used to store reset tokens as a non-reversible digest. */
export const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

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
// A session counts as "live" (actively in use on some device right now) if it
// was seen within this window. Used for single-active-session detection.
export const LIVE_WINDOW_SEC = 120;

/** Short, PII-light fingerprint of the requesting device, for the security view. */
export function clientMeta(req) {
  const ua = (req.headers['user-agent'] || '').slice(0, 200) || null;
  // req.ip is undefined without trust proxy; fall back to the socket address.
  const ip = (req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
  return { ua, ip };
}

export async function createSession(res, userId, req = null) {
  const token = randomBytes(32).toString('hex');
  const { ua, ip } = req ? clientMeta(req) : { ua: null, ip: null };
  await db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, last_seen, user_agent, ip)
     VALUES (?,?,datetime('now', ?),datetime('now'),?,?)`)
    .run(token, userId, `+${SESSION_DAYS} days`, ua, ip);
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

export async function destroySession(req, res) {
  const token = readCookie(req, SESS_COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
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
export async function loadSession(req, res, next) {
  try {
    const token = readCookie(req, SESS_COOKIE);
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      const row = await db.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
      if (row) {
        if (row.status === 'frozen') {
          await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
          setSessionCookie(res, '', true);
        } else {
          req.user = row;
          req.sessionToken = token;
          // Heartbeat: refresh last_seen at most once a minute so liveness stays
          // current without a DB write on every request.
          await db.prepare(
            `UPDATE sessions SET last_seen = datetime('now')
             WHERE token = ? AND (last_seen IS NULL OR last_seen < datetime('now','-60 seconds'))`)
            .run(token);
        }
      }
    }
  } catch { /* auth load never rejects — continue unauthenticated */ }
  next();
}

/**
 * Summary of a member's sessions for single-active-session logic.
 * NOTE (accepted limitation): `othersLive` counts only sessions seen within
 * LIVE_WINDOW_SEC, so a dormant (idle) stolen session is not flagged. `others`
 * exposes the raw count for a stricter UI; a full fix (new-device alerts +
 * shorter idle-session lifetime) is a product feature beyond this change set.
 * The primary theft defences remain the SameSite=Strict/HttpOnly cookie,
 * reset-revokes-all, and logout-all.
 */
export async function sessionStatus(userId, currentToken) {
  const rows = await db.prepare(
    `SELECT token, last_seen FROM sessions
     WHERE user_id = ? AND expires_at > datetime('now')`).all(userId);
  const liveCutoff = Date.now() - LIVE_WINDOW_SEC * 1000;
  let others = 0, othersLive = 0;
  for (const r of rows) {
    if (r.token === currentToken) continue;
    others += 1;
    // last_seen is a UTC 'YYYY-MM-DD HH:MM:SS' string; append Z to parse as UTC.
    const seen = r.last_seen ? Date.parse(r.last_seen.replace(' ', 'T') + 'Z') : 0;
    if (seen >= liveCutoff) othersLive += 1;
  }
  return { total: rows.length, others, othersLive };
}

/** List a member's active sessions (current one flagged) for the security view. */
export async function listSessions(userId, currentToken) {
  const liveCutoff = Date.now() - LIVE_WINDOW_SEC * 1000;
  const rows = await db.prepare(
    `SELECT token, user_agent, ip, created_at, last_seen FROM sessions
     WHERE user_id = ? AND expires_at > datetime('now')
     ORDER BY last_seen DESC`).all(userId);
  return rows.map((r) => {
    const seen = r.last_seen ? Date.parse(r.last_seen.replace(' ', 'T') + 'Z') : 0;
    return {
      current: r.token === currentToken,
      userAgent: r.user_agent || null,
      ip: r.ip || null,
      createdAt: r.created_at,
      lastSeen: r.last_seen || null,
      live: seen >= liveCutoff,
    };
  });
}

/** Revoke every session for a user except (optionally) the current one. */
export async function revokeOtherSessions(userId, keepToken) {
  return (await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .run(userId, keepToken || '')).changes;
}
export async function revokeAllSessions(userId) {
  return (await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)).changes;
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
