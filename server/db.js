import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.OSMO_DB || join(ROOT, 'data', 'osmobank.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/** Run fn inside a transaction; roll back on throw. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function balance(userId, currency = 'USDC') {
  const row = db.prepare('SELECT COALESCE(SUM(delta),0) AS b FROM ledger WHERE user_id = ? AND currency = ?')
    .get(userId, currency);
  return Math.round((row?.b ?? 0) * 100) / 100;
}

export function audit(actorId, action, subject = null, detail = null) {
  db.prepare('INSERT INTO audit_log (actor_id, action, subject, detail) VALUES (?,?,?,?)')
    .run(actorId, action, subject, detail);
}

export function hashPass(passphrase) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(passphrase, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','review','frozen')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
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
`);

// ---- one-time seed -------------------------------------------------------
const empty = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
if (empty) {
  const adminPass = process.env.OSMO_ADMIN_PASS || randomBytes(9).toString('base64url');
  const managerPass = process.env.OSMO_MANAGER_PASS || randomBytes(9).toString('base64url');

  tx(() => {
    const addUser = db.prepare(
      'INSERT INTO users (handle, name, email, pass, role, status) VALUES (?,?,?,?,?,?)');
    const seedLedger = db.prepare(
      "INSERT INTO ledger (user_id, currency, delta, kind, memo) VALUES (?,?,?,'seed','founding balance')");

    const adminId = Number(addUser.run('admin', 'Osmo Operator', 'admin@osmo.money', hashPass(adminPass), 'admin', 'active').lastInsertRowid);
    const marisolId = Number(addUser.run('marisol', 'Marisol Vega', 'marisol@osmo.money', hashPass(managerPass), 'manager', 'active').lastInsertRowid);
    const demo = [
      ['rosa', 'Rosa Delgado', 'rosa@osmo.money', 'active'],
      ['tunde', 'Tunde Adeyemi', 'tunde@osmo.money', 'review'],
      ['lena', 'Lena Fischer', 'lena@osmo.money', 'active'],
    ].map(([h, n, e, s]) => Number(addUser.run(h, n, e, hashPass(randomBytes(12).toString('hex')), 'member', s).lastInsertRowid));

    for (const id of [adminId, marisolId, ...demo]) {
      seedLedger.run(id, 'USDC', 12450, );
      seedLedger.run(id, 'OSM', id === adminId ? 84300 : 10);
    }

    const addVenture = db.prepare(
      'INSERT INTO ventures (name, sector, blurb, apy, min_amount, target_amount, status, manager_id, badge, payout_freq) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const v = {};
    v.helios = Number(addVenture.run('Helios Grid', 'ENERGY', 'Solar microgrids for 240 off-grid villages across East Africa. Revenue from power purchase agreements.', 12.4, 100, 2000000, 'active', marisolId, null, 'quarterly').lastInsertRowid);
    v.ferrymill = Number(addVenture.run('Ferrymill Robotics', 'ROBOTICS', 'Warehouse autonomy retrofits for mid-size EU logistics operators. Leasing model, 3-year contracts.', 9.2, 100, 1500000, 'active', marisolId, null, 'quarterly').lastInsertRowid);
    v.atlas = Number(addVenture.run('Atlas Dry Ports', 'LOGISTICS', 'Inland freight hubs decongesting two LATAM port corridors. Storage + customs fees, inflation-linked.', 7.8, 250, 1200000, 'active', marisolId, null, 'quarterly').lastInsertRowid);
    v.nova = Number(addVenture.run('Nova Reef', 'OCEAN', 'Regenerative aquaculture — kelp and shellfish arrays that clean water and sell premium harvests.', 11.1, 100, 2400000, 'active', marisolId, 'SERIES B IN VOTE', 'quarterly').lastInsertRowid);
    v.kite = Number(addVenture.run('Kite Mesh', 'DATA', 'Community-owned wireless mesh covering transit deserts in 3 metros. Subscription revenue share.', 8.6, 100, 900000, 'active', marisolId, 'NEW LISTING', 'monthly').lastInsertRowid);
    v.meridian = Number(addVenture.run('Meridian Water', 'INFRA', 'Atmospheric water generation for drought-hit municipalities. Take-or-pay utility contracts.', 10.2, 100, 1800000, 'active', marisolId, 'CLOSES AUG 12', 'quarterly').lastInsertRowid);
    addVenture.run('Terrace Farms', 'AGRI', 'Greenhouse REIT — year-round produce on urban rooftops. Diligence in review, Fieldstone ETA Jul 18.', 8.9, 250, 1600000, 'pending', marisolId, null, 'quarterly');
    addVenture.run('Kite Mesh — Metro 4', 'DATA', 'Expansion of the community mesh to a fourth metro. Diligence and audit complete, legal pending.', 8.6, 100, 400000, 'pending', marisolId, null, 'monthly');

    // demo stakes so pro-rata payouts have several recipients
    const invest = db.prepare('INSERT INTO investments (user_id, venture_id, amount) VALUES (?,?,?)');
    const led = db.prepare("INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,?,?,?,'venture',?,?)");
    const stakes = [
      [demo[0], v.helios, 3100], [demo[0], v.nova, 900],
      [demo[2], v.helios, 1500], [demo[2], v.ferrymill, 2200],
      [marisolId, v.atlas, 1000],
    ];
    for (const [uid, vid, amt] of stakes) {
      invest.run(uid, vid, amt);
      led.run(uid, 'USDC', -amt, 'invest', vid, 'seed stake');
    }

    const addProposal = db.prepare(
      "INSERT INTO proposals (code, title, blurb, status, quorum_pct, ends_at) VALUES (?,?,?,?,?,datetime('now', ?))");
    addProposal.run('OSM-042', 'Fund Nova Reef Series B with 2.4M OSM from the treasury',
      'Proposed by @marisol. Deploys 0.84% of treasury into the Series B round at 11.1% target APY. Diligence report audited by Fieldstone. Dividends begin Q4 2026.',
      'live', 30, '+62 hours');
    addProposal.run('OSM-041', 'List Kite Mesh on the floor', 'Turnout 71%', 'passed', 30, '-5 days');
    addProposal.run('OSM-040', 'Cut swap fee to 0.1%', 'Turnout 68%', 'passed', 30, '-20 days');
    addProposal.run('OSM-039', 'Open a physical branch', 'Turnout 77%', 'rejected', 30, '-38 days');

    db.prepare(
      "INSERT INTO fundraisers (venture_id, title, blurb, target, raised, backers, apy, min_amount, ends_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','+9 days','+6 hours'))")
      .run(v.nova, 'Nova Reef Series B Raise',
        'Kelp and shellfish arrays that clean coastal water and sell premium harvests. This round funds 3 new reef sites and a processing barge. Backed by proposal OSM-042.',
        2400000, 1600000, 1204, 11.1, 100);

    audit(adminId, 'seed', 'db', 'initial seed');
  });

  /* eslint-disable no-console */
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  OsmoBank seeded. Sign-in credentials (shown once):          ');
  console.log(`│    admin    → admin@osmo.money    / ${adminPass}`);
  console.log(`│    manager  → marisol@osmo.money  / ${managerPass}`);
  console.log('│  Delete data/osmobank.db to reseed.                          ');
  console.log('└─────────────────────────────────────────────────────────────┘');
}
