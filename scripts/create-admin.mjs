/* Create (or promote) an admin user.
 *
 * Credentials come from the ENVIRONMENT so the password is never written into a
 * file, an npm script, or command arguments. It targets whatever database the
 * env points to — local file by default, or Turso when the TURSO_* vars are set
 * (so the same command provisions the live site once Turso is connected).
 *
 * Usage:
 *   ADMIN_EMAIL=jay@osmobank.com ADMIN_HANDLE=jay ADMIN_PASS='********' npm run admin:create
 *
 * Production (live osmobank.com) — also export the DB connection:
 *   TURSO_DATABASE_URL=libsql://<db>.turso.io TURSO_AUTH_TOKEN=<token> \
 *   ADMIN_EMAIL=jay@osmobank.com ADMIN_HANDLE=jay ADMIN_PASS='********' npm run admin:create
 *
 * Idempotent: an existing user with that email or handle is promoted to admin and
 * has its password reset; otherwise a new admin is created. The password is
 * scrypt-hashed (never stored in plaintext) and never echoed by this script. */
import { db, initDb, hashPass } from '../server/db.js';

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const handle = (process.env.ADMIN_HANDLE || email.split('@')[0] || '').trim().toLowerCase().replace(/^@/, '');
const pass = process.env.ADMIN_PASS || '';
const name = process.env.ADMIN_NAME || handle;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HANDLE_RE = /^[a-z0-9_]{2,24}$/;
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

if (!EMAIL_RE.test(email)) fail('ADMIN_EMAIL is missing or invalid');
if (!HANDLE_RE.test(handle)) fail('ADMIN_HANDLE invalid (2–24 chars: a-z, 0-9, _)');
if (pass.length < 12) fail('ADMIN_PASS must be at least 12 characters');

await initDb();

const existing = await db.prepare('SELECT id FROM users WHERE email = ? OR handle = ?').get(email, handle);
if (existing) {
  await db.prepare("UPDATE users SET role = 'admin', status = 'active', pass = ? WHERE id = ?")
    .run(hashPass(pass), existing.id);
  console.log(`✅ Promoted user #${existing.id} to admin and reset its password (${email}).`);
} else {
  const r = await db.prepare(
    "INSERT INTO users (handle, name, email, pass, role, status) VALUES (?,?,?,?,'admin','active')")
    .run(handle, name, email, hashPass(pass));
  console.log(`✅ Created admin #${Number(r.lastInsertRowid)} — ${email} / @${handle}.`);
}
process.exit(0);
