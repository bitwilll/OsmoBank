/* RFC 6238 TOTP (time-based one-time password) + RFC 4648 base32.
 * Standard 30-second window, 6 digits, HMAC-SHA1 — compatible with Google
 * Authenticator, Authy, 1Password, etc. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** New random base32 secret (20 bytes = 160 bits, the RFC-recommended length). */
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

/** The 6-digit code for a given secret at a given time step. */
export function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function totpNow(secret, timeMs = Date.now()) {
  return totpAt(secret, Math.floor(timeMs / 1000 / 30));
}

/** Verify a user-supplied code, tolerating ±1 step of clock skew. */
export function verifyTotp(secret, code, timeMs = Date.now()) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  const step = Math.floor(timeMs / 1000 / 30);
  for (let w = -1; w <= 1; w++) {
    const expected = totpAt(secret, step + w);
    const a = Buffer.from(expected), b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// URI an authenticator app scans from a QR. */
export function otpauthUri(secret, account, issuer = 'OsmoBank') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
