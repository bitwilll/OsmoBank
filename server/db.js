/* Data layer — libSQL / Turso (async).
 *
 * Runs on serverless (Vercel) against a hosted Turso database, and locally /
 * in tests against a libSQL file or in-memory DB. The public API mirrors the
 * old node:sqlite shape — `db.prepare(sql).get/all/run(...args)` — but every
 * terminal call is async, so call sites simply `await`. Transactions use an
 * AsyncLocalStorage so statements inside `tx(fn)` transparently run on the
 * transaction connection without threading it through every call.
 *
 * Connection resolution (first match wins):
 *   TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)   → hosted Turso (durable)
 *   OSMO_DB                                    → path or libsql/file: URL
 *   on Vercel with neither                     → /tmp/osmobank.db (writable,
 *                                                but EPHEMERAL per instance —
 *                                                a stop-gap so the app works
 *                                                until a Turso URL is set)
 *   else                                       → local data/osmobank.db file
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveConfig() {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return { url, authToken: process.env.TURSO_AUTH_TOKEN };
  // Local / test: a path or an explicit libsql/file/:memory: URL. On Vercel the
  // deployment filesystem is read-only except /tmp, so fall back there — this
  // lets login/signup work without Turso, though data is per-instance ephemeral.
  let target = process.env.OSMO_DB
    || (process.env.VERCEL ? '/tmp/osmobank.db' : join(ROOT, 'data', 'osmobank.db'));
  if (/^(libsql:|file:|http:|https:|:memory:)/.test(target)) {
    if (target.startsWith('file:')) mkdirSync(dirname(target.slice(5)) || '.', { recursive: true });
    return { url: target };
  }
  if (!isAbsolute(target)) target = join(ROOT, target);
  mkdirSync(dirname(target), { recursive: true });
  return { url: `file:${target}` };
}

const config = resolveConfig();
// Remote Turso (libsql://, https://) uses the fetch-based web client — no native
// binding to bundle on serverless. Local file:/:memory: uses the node client.
const isRemote = /^(libsql:|https?:|wss?:)/.test(config.url);
const { createClient } = isRemote
  ? await import('@libsql/client/web')
  : await import('@libsql/client/node');
export const client = createClient(config);

// ---- async statement shim --------------------------------------------------
const als = new AsyncLocalStorage();

// libSQL rejects `undefined`; coerce params to the accepted set.
const normArgs = (args) => args.map((v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
});

async function run1(sql, args) {
  const conn = als.getStore() || client;
  return args && args.length ? conn.execute({ sql, args: normArgs(args) }) : conn.execute(sql);
}

export const db = {
  prepare(sql) {
    return {
      async get(...args) { return (await run1(sql, args)).rows[0]; },
      async all(...args) { return (await run1(sql, args)).rows; },
      async run(...args) {
        const r = await run1(sql, args);
        return { lastInsertRowid: r.lastInsertRowid, changes: Number(r.rowsAffected || 0) };
      },
    };
  },
  // Execute one or more statements (schema, migrations). No params.
  async exec(sql) { await client.executeMultiple(sql); },
};

/** Run fn inside a transaction; roll back on throw. Nested calls reuse the outer txn. */
export async function tx(fn) {
  if (als.getStore()) return fn(); // already inside a transaction
  const t = await client.transaction('write');
  try {
    const out = await als.run(t, () => fn());
    await t.commit();
    return out;
  } catch (e) {
    try { await t.rollback(); } catch { /* connection may be gone */ }
    throw e;
  }
}

export async function balance(userId, currency = 'USDC') {
  const row = await db.prepare('SELECT COALESCE(SUM(delta),0) AS b FROM ledger WHERE user_id = ? AND currency = ?')
    .get(userId, currency);
  return Math.round((Number(row?.b) || 0) * 100) / 100;
}

export async function audit(actorId, action, subject = null, detail = null) {
  await db.prepare('INSERT INTO audit_log (actor_id, action, subject, detail) VALUES (?,?,?,?)')
    .run(actorId, action, subject, detail);
}

export function hashPass(passphrase) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(passphrase, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','review','frozen')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
  last_seen TEXT, user_agent TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL, address TEXT NOT NULL, label TEXT,
  kind TEXT NOT NULL DEFAULT 'hd' CHECK (kind IN ('hd','imported','watch')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, chain, address));
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL DEFAULT 'USDC', delta REAL NOT NULL,
  kind TEXT NOT NULL, ref_type TEXT, ref_id INTEGER, memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, currency);
CREATE TABLE IF NOT EXISTS ventures (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '', apy REAL NOT NULL,
  min_amount REAL NOT NULL DEFAULT 100, target_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','closed','rejected')),
  manager_id INTEGER REFERENCES users(id), badge TEXT,
  payout_freq TEXT NOT NULL DEFAULT 'quarterly',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS investments (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  venture_id INTEGER NOT NULL REFERENCES ventures(id), amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exited')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_inv_venture ON investments(venture_id, status);
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY, venture_id INTEGER NOT NULL REFERENCES ventures(id),
  kind TEXT NOT NULL CHECK (kind IN ('dividend','reimbursement')),
  total REAL NOT NULL, memo TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payout_items (
  id INTEGER PRIMARY KEY, payout_id INTEGER NOT NULL REFERENCES payouts(id),
  user_id INTEGER NOT NULL REFERENCES users(id), amount REAL NOT NULL);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'SAVINGS',
  icon TEXT NOT NULL DEFAULT 'flag', target REAL NOT NULL,
  saved REAL NOT NULL DEFAULT 0, autosave REAL NOT NULL DEFAULT 0, eta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY, from_user INTEGER REFERENCES users(id),
  to_user INTEGER REFERENCES users(id), chain TEXT NOT NULL DEFAULT 'internal',
  to_address TEXT, currency TEXT NOT NULL DEFAULT 'USDC', amount REAL NOT NULL,
  txid TEXT, status TEXT NOT NULL DEFAULT 'settled' CHECK (status IN ('settled','broadcast','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','passed','rejected')),
  quorum_pct REAL NOT NULL DEFAULT 30, ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS votes (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  support INTEGER NOT NULL, power REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (proposal_id, user_id));
CREATE TABLE IF NOT EXISTS fundraisers (
  id INTEGER PRIMARY KEY, venture_id INTEGER NOT NULL REFERENCES ventures(id),
  title TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '', target REAL NOT NULL,
  raised REAL NOT NULL DEFAULT 0, backers INTEGER NOT NULL DEFAULT 0,
  apy REAL NOT NULL, min_amount REAL NOT NULL DEFAULT 100,
  ends_at TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')));
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL,
  subject TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS user_2fa (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  cred_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT, label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  challenge TEXT NOT NULL, purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT NOT NULL DEFAULT 'OsmoCard', brand TEXT NOT NULL DEFAULT 'OSMO',
  pan TEXT NOT NULL, last4 TEXT NOT NULL, exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL, cvv TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'virtual' CHECK (kind IN ('virtual','physical')),
  frozen INTEGER NOT NULL DEFAULT 0,
  daily_limit REAL NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS gift_cards (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  brand TEXT NOT NULL, amount REAL NOT NULL, code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_at TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_reset_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS card_provisions (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('apple','google','samsung')),
  token_ref TEXT NOT NULL, device TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(card_id, platform));
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  email TEXT, handle TEXT,
  category TEXT NOT NULL, message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','system')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets(status, id);
`;

async function seed() {
  const adminPass = process.env.OSMO_ADMIN_PASS || randomBytes(9).toString('base64url');
  const managerPass = process.env.OSMO_MANAGER_PASS || randomBytes(9).toString('base64url');

  await tx(async () => {
    const addUser = (h, n, e, p, role, status) => db.prepare(
      'INSERT INTO users (handle, name, email, pass, role, status) VALUES (?,?,?,?,?,?)')
      .run(h, n, e, p, role, status);
    const seedLedger = (uid, cur, delta, memo = 'founding balance') => db.prepare(
      "INSERT INTO ledger (user_id, currency, delta, kind, memo) VALUES (?,?,?,'seed',?)")
      .run(uid, cur, delta, memo);

    const adminId = Number((await addUser('admin', 'Osmo Operator', 'admin@osmo.money', hashPass(adminPass), 'admin', 'active')).lastInsertRowid);
    const marisolId = Number((await addUser('marisol', 'Marisol Vega', 'marisol@osmo.money', hashPass(managerPass), 'manager', 'active')).lastInsertRowid);
    const demo = [];
    for (const [h, n, e, s] of [
      ['rosa', 'Rosa Delgado', 'rosa@osmo.money', 'active'],
      ['tunde', 'Tunde Adeyemi', 'tunde@osmo.money', 'review'],
      ['lena', 'Lena Fischer', 'lena@osmo.money', 'active'],
    ]) demo.push(Number((await addUser(h, n, e, hashPass(randomBytes(12).toString('hex')), 'member', s)).lastInsertRowid));

    const luhn = (body) => {
      let sum = 0, alt = true;
      for (let i = body.length - 1; i >= 0; i--) {
        let d = body.charCodeAt(i) - 48;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
      }
      return body + String((10 - (sum % 10)) % 10);
    };
    const addCard = (uid, pan, cvv) => db.prepare(
      `INSERT INTO cards (user_id, label, brand, pan, last4, exp_month, exp_year, cvv, kind, daily_limit)
       VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uid, 'OsmoCard', 'OSMO', pan, pan.slice(-4), 9, 2028, cvv, 'virtual', 2000);
    for (const id of [adminId, marisolId, ...demo]) {
      await seedLedger(id, 'USDC', 12450);
      await seedLedger(id, 'OSM', id === adminId ? 84300 : 10);
      const pan = luhn('473501' + String(1000000000 + id * 7919).slice(-9));
      await addCard(id, pan, String((id * 137) % 1000).padStart(3, '0'));
    }

    const addVenture = (...a) => db.prepare(
      'INSERT INTO ventures (name, sector, blurb, apy, min_amount, target_amount, status, manager_id, badge, payout_freq) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...a);
    const v = {};
    v.helios = Number((await addVenture('Helios Grid', 'ENERGY', 'Solar microgrids for 240 off-grid villages across East Africa. Revenue from power purchase agreements.', 12.4, 100, 2000000, 'active', marisolId, null, 'quarterly')).lastInsertRowid);
    v.ferrymill = Number((await addVenture('Ferrymill Robotics', 'ROBOTICS', 'Warehouse autonomy retrofits for mid-size EU logistics operators. Leasing model, 3-year contracts.', 9.2, 100, 1500000, 'active', marisolId, null, 'quarterly')).lastInsertRowid);
    v.atlas = Number((await addVenture('Atlas Dry Ports', 'LOGISTICS', 'Inland freight hubs decongesting two LATAM port corridors. Storage + customs fees, inflation-linked.', 7.8, 250, 1200000, 'active', marisolId, null, 'quarterly')).lastInsertRowid);
    v.nova = Number((await addVenture('Nova Reef', 'OCEAN', 'Regenerative aquaculture — kelp and shellfish arrays that clean water and sell premium harvests.', 11.1, 100, 2400000, 'active', marisolId, 'SERIES B IN VOTE', 'quarterly')).lastInsertRowid);
    v.kite = Number((await addVenture('Kite Mesh', 'DATA', 'Community-owned wireless mesh covering transit deserts in 3 metros. Subscription revenue share.', 8.6, 100, 900000, 'active', marisolId, 'NEW LISTING', 'monthly')).lastInsertRowid);
    v.meridian = Number((await addVenture('Meridian Water', 'INFRA', 'Atmospheric water generation for drought-hit municipalities. Take-or-pay utility contracts.', 10.2, 100, 1800000, 'active', marisolId, 'CLOSES AUG 12', 'quarterly')).lastInsertRowid);
    await addVenture('Terrace Farms', 'AGRI', 'Greenhouse REIT — year-round produce on urban rooftops. Diligence in review, Fieldstone ETA Jul 18.', 8.9, 250, 1600000, 'pending', marisolId, null, 'quarterly');
    await addVenture('Kite Mesh — Metro 4', 'DATA', 'Expansion of the community mesh to a fourth metro. Diligence and audit complete, legal pending.', 8.6, 100, 400000, 'pending', marisolId, null, 'monthly');

    const invest = (uid, vid, amt) => db.prepare('INSERT INTO investments (user_id, venture_id, amount) VALUES (?,?,?)').run(uid, vid, amt);
    const led = (uid, delta, vid) => db.prepare("INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,'USDC',?,'invest','venture',?,'seed stake')").run(uid, delta, vid);
    for (const [uid, vid, amt] of [
      [demo[0], v.helios, 3100], [demo[0], v.nova, 900],
      [demo[2], v.helios, 1500], [demo[2], v.ferrymill, 2200],
      [marisolId, v.atlas, 1000],
    ]) { await invest(uid, vid, amt); await led(uid, -amt, vid); }

    const addProposal = (...a) => db.prepare(
      "INSERT INTO proposals (code, title, blurb, status, quorum_pct, ends_at) VALUES (?,?,?,?,?,datetime('now', ?))").run(...a);
    await addProposal('OSM-042', 'Fund Nova Reef Series B with 2.4M OSM from the treasury',
      'Proposed by @marisol. Deploys 0.84% of treasury into the Series B round at 11.1% target APY. Diligence report audited by Fieldstone. Dividends begin Q4 2026.',
      'live', 30, '+62 hours');
    await addProposal('OSM-041', 'List Kite Mesh on the floor', 'Turnout 71%', 'passed', 30, '-5 days');
    await addProposal('OSM-040', 'Cut swap fee to 0.1%', 'Turnout 68%', 'passed', 30, '-20 days');
    await addProposal('OSM-039', 'Open a physical branch', 'Turnout 77%', 'rejected', 30, '-38 days');

    await db.prepare(
      "INSERT INTO fundraisers (venture_id, title, blurb, target, raised, backers, apy, min_amount, ends_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','+9 days','+6 hours'))")
      .run(v.nova, 'Nova Reef Series B Raise',
        'Kelp and shellfish arrays that clean coastal water and sell premium harvests. This round funds 3 new reef sites and a processing barge.',
        2400000, 1600000, 1204, 11.1, 100);

    await audit(adminId, 'seed', 'db', 'initial seed');
  });

  /* eslint-disable no-console */
  console.log('OsmoBank seeded. Operator sign-in (shown once):');
  console.log(`  admin   → admin@osmo.money   / ${adminPass}`);
  console.log(`  manager → marisol@osmo.money / ${managerPass}`);
}

// The environment is authoritative for operator credentials: if OSMO_ADMIN_PASS /
// OSMO_MANAGER_PASS are set (or changed) AFTER the first seed — e.g. added to the
// deployment later — update the stored hash on cold start so operators are never
// locked out behind a random seed-time password. Local duplicate of verifyPass
// (lib/util.js imports this module, so importing it back would be a cycle).
function passMatches(passphrase, stored) {
  const [scheme, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(String(passphrase), salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function syncOperatorPass(email, pass) {
  if (!pass) return;
  const row = await db.prepare('SELECT id, pass FROM users WHERE email = ?').get(email);
  if (!row || passMatches(pass, row.pass)) return;
  await db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(pass), row.id);
  await audit(row.id, 'pass_sync', 'user:' + row.id, 'operator password updated from environment');
}

// ---- one-time initialisation (schema + seed) -------------------------------
let initPromise = null;
export function initDb() {
  if (!initPromise) initPromise = (async () => {
    await db.exec(SCHEMA);
    if (process.env.OSMO_SEED !== '0') {
      const someone = await db.prepare('SELECT 1 FROM users LIMIT 1').get();
      if (!someone) {
        try { await seed(); }
        catch (e) {
          // A concurrent cold start may have seeded first; a unique clash there
          // is benign. Re-throw anything else.
          if (!/UNIQUE|constraint/i.test(String(e?.message))) throw e;
        }
      }
    }
    await syncOperatorPass('admin@osmo.money', process.env.OSMO_ADMIN_PASS);
    await syncOperatorPass('marisol@osmo.money', process.env.OSMO_MANAGER_PASS);
  })().catch((e) => {
    // Never cache a failed init (e.g. the DB is unreachable / not yet
    // configured). Clearing the memo lets the next request retry, so the
    // instance self-heals once the database becomes available — no redeploy.
    initPromise = null;
    throw e;
  });
  return initPromise;
}
