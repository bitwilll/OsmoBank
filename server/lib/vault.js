/* Envelope encryption for identity data (Osmo Assure).
 *
 * KYC submissions contain real personal data — legal name, date of birth, a
 * document number — so nothing identifying is ever written to the database in
 * plaintext. Each submission is sealed with AES-256-GCM, which also
 * authenticates the ciphertext: a tampered record fails to open rather than
 * decrypting to something wrong.
 *
 * What this protects against, honestly:
 *   - A database dump (a leaked Turso replica, a stolen backup) yields
 *     ciphertext only, PROVIDED the key lives outside the database — that is
 *     what OSMO_KYC_KEY is for.
 *   - Casual/incidental exposure through the app: no endpoint returns the
 *     sealed fields except the reviewer flow, and every open is audited.
 *
 * What it does NOT claim:
 *   - It is not end-to-end encrypted. Reviewers must read a submission to
 *     verify it, so the server necessarily holds the key. Anyone who controls
 *     BOTH the database and the key material can read submissions.
 *   - Without OSMO_KYC_KEY the key is generated once and kept in the `meta`
 *     table. The feature still works and access is still audited, but a
 *     database dump would then include the key — so a deployment handling real
 *     identity documents should set OSMO_KYC_KEY.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const META_KEY = 'kyc_data_key';

/** Accepts 64 hex chars or 32 bytes of base64. */
function parseKey(raw) {
  const v = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v, 'base64');
  return b.length === KEY_BYTES ? b : null;
}

let cached = null;

/**
 * Resolve the data key. Prefers OSMO_KYC_KEY (key outside the database);
 * otherwise generates one once and stores it in `meta`, logging the weaker
 * guarantee so it is never a silent downgrade.
 */
export async function dataKey() {
  if (cached) return cached;
  const fromEnv = process.env.OSMO_KYC_KEY ? parseKey(process.env.OSMO_KYC_KEY) : null;
  if (process.env.OSMO_KYC_KEY && !fromEnv) {
    throw new Error('OSMO_KYC_KEY must be 64 hex characters or 32 bytes of base64');
  }
  if (fromEnv) { cached = { key: fromEnv, external: true }; return cached; }

  const existing = await db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
  if (existing?.value) {
    const k = parseKey(existing.value);
    if (!k) throw new Error('stored KYC data key is corrupt');
    cached = { key: k, external: false };
    return cached;
  }
  const generated = randomBytes(KEY_BYTES);
  await db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT (key) DO NOTHING')
    .run(META_KEY, generated.toString('base64'));
  // Re-read: a concurrent cold start may have won the insert.
  const settled = parseKey((await db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY)).value);
  console.error(
    'Osmo Assure: no OSMO_KYC_KEY set — the identity data key is stored in the database. '
    + 'Set OSMO_KYC_KEY to keep it out of database dumps.');
  cached = { key: settled, external: false };
  return cached;
}

/** True when the key lives outside the database (the stronger configuration). */
export async function keyIsExternal() {
  return (await dataKey()).external;
}

/** Seal a JSON-serialisable value. Returns "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export async function seal(value) {
  const { key } = await dataKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Open a sealed value. Throws if the record was tampered with or the key is wrong. */
export async function open(sealed) {
  const { key } = await dataKey();
  const [v, ivB, tagB, ctB] = String(sealed).split('.');
  if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('sealed record is malformed');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/** Constant-time compare for short secrets (used by the document-number check). */
export const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Test seam: forget the cached key (used when a suite swaps environments). */
export const _resetKeyCache = () => { cached = null; };
