// Production seeding behavior: without OSMO_SEED_DEMO=1 the database contains
// only the two operator accounts and zero fixtures; a DB that was seeded with
// demo fixtures earlier is purged exactly once; /api/stats reports real
// aggregates in both modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember, loginAdmin } from './helper.js';

test('clean seed (no OSMO_SEED_DEMO): operators only, empty floor, real stats', async (t) => {
  const srv = await bootServer({ OSMO_SEED_DEMO: '0' });
  t.after(() => srv.stop());

  // Operators exist and can sign in; no demo members were created.
  const { c: admin } = await loginAdmin(srv.base);
  const stats = (await client(srv.base).get('/api/stats')).json;
  assert.equal(stats.members, 2); // admin + manager, nobody else
  assert.equal(stats.treasuryUsd, 0); // no founding balances
  assert.equal(stats.dividendsPaid, 0);
  assert.equal(stats.liveVotes, 0);
  assert.equal(stats.proposalsPassed, 0);
  assert.equal(stats.topApy, null);
  assert.equal(stats.activeVentures, 0);

  // The floor and governance are honestly empty.
  const ventures = (await admin.get('/api/ventures')).json.ventures;
  assert.deepEqual(ventures, []);
  const proposals = (await admin.get('/api/proposals')).json.proposals;
  assert.deepEqual(proposals, []);
  assert.equal((await admin.get('/api/fundraiser')).status, 404);

  // A new member registers into a truly clean world.
  const { c } = await registerMember(srv.base, { fund: false });
  const me = (await c.get('/api/me')).json;
  assert.deepEqual(me.balances, { USDC: 0, OSM: 0 });
});

test('demo-seeded DB is purged once when demo mode is off', async (t) => {
  // Boot 1: demo fixtures + one REAL member with a REAL deposit.
  const srv1 = await bootServer(); // OSMO_SEED_DEMO=1 default
  const { c: c1, user } = await registerMember(srv1.base, { fund: false });
  await c1.post('/api/deposits', { currency: 'USDC', amount: 777 });
  assert.equal((await c1.get('/api/ventures')).json.ventures.length > 0, true, 'demo ventures present');
  srv1.stop();
  await new Promise((r) => setTimeout(r, 200));

  // Boot 2: same DB, demo mode OFF → purge runs.
  const srv2 = await bootServer({ OSMO_SEED_DEMO: '0', OSMO_DB: srv1.dbPath });
  t.after(() => srv2.stop());
  const { c: admin } = await loginAdmin(srv2.base);
  assert.deepEqual((await admin.get('/api/ventures')).json.ventures, [], 'demo ventures purged');
  assert.deepEqual((await admin.get('/api/proposals')).json.proposals, [], 'demo proposals purged');
  assert.equal((await admin.get('/api/fundraiser')).status, 404, 'demo fundraiser purged');

  const stats = (await client(srv2.base).get('/api/stats')).json;
  assert.equal(stats.members, 3, 'operators + the real member survive');
  assert.equal(stats.treasuryUsd, 777, 'real deposit survives; founding balances purged');

  // The real member still logs in with their data intact.
  const c2 = client(srv2.base);
  const login = await c2.post('/api/auth/login', { identifier: user.handle, passphrase: 'correct-horse-battery' });
  assert.equal(login.status, 200);
  const me = (await c2.get('/api/me')).json;
  assert.equal(me.balances.USDC, 777);

  // Purge is one-shot: a third boot must not run it again (meta flag set).
  srv2.stop();
  await new Promise((r) => setTimeout(r, 200));
  const srv3 = await bootServer({ OSMO_SEED_DEMO: '0', OSMO_DB: srv1.dbPath });
  t.after(() => srv3.stop());
  const c3 = client(srv3.base);
  const login3 = await c3.post('/api/auth/login', { identifier: user.handle, passphrase: 'correct-horse-battery' });
  assert.equal(login3.status, 200);
  assert.equal((await c3.get('/api/me')).json.balances.USDC, 777);
});

test('/api/stats reports real aggregates in demo mode too', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const stats = (await client(srv.base).get('/api/stats')).json;
  assert.equal(stats.members, 5); // admin + manager + rosa/tunde/lena
  assert.equal(stats.liveVotes, 1); // OSM-042
  assert.equal(stats.liveProposalCode, 'OSM-042');
  assert.equal(stats.proposalsPassed, 2);
  assert.equal(stats.topApy, 12.4);
  assert.equal(stats.activeVentures, 6);
  assert.ok(stats.treasuryUsd > 0);
});

test('OSMO_STATS_DEFAULTS seeds curated figures once; operator edits win forever', async (t) => {
  const DEFAULTS = JSON.stringify({ treasuryUsd: 284000000, members: 48201, proposalsPassed: 41, liveVotes: 1 });
  const srv1 = await bootServer({ OSMO_STATS_DEFAULTS: DEFAULTS });
  const s1 = (await client(srv1.base).get('/api/stats')).json;
  assert.equal(s1.treasuryUsd, 284000000);
  assert.equal(s1.members, 48201);
  assert.equal(s1.proposalsPassed, 41);
  assert.deepEqual([...s1.curated].sort(), ['liveVotes', 'members', 'proposalsPassed', 'treasuryUsd']);

  // The operator clears everything → live values; a reboot with the env still
  // set must NOT re-seed (the meta row exists, even when empty).
  const { c: admin } = await loginAdmin(srv1.base);
  await admin.put('/api/admin/stats', {});
  srv1.stop();
  await new Promise((r) => setTimeout(r, 200));

  const srv2 = await bootServer({ OSMO_STATS_DEFAULTS: DEFAULTS, OSMO_DB: srv1.dbPath });
  t.after(() => srv2.stop());
  const s2 = (await client(srv2.base).get('/api/stats')).json;
  assert.deepEqual(s2.curated, [], 'operator clear survives reboot despite env defaults');
  assert.equal(s2.members, 5); // live demo-seed count
});

// ---- operator credential sync -----------------------------------------------

test('operator email sync: applied when free, refused when another account holds it', async (t) => {
  const OPS = 'ops@example.com';
  // Free address → the seeded operator row adopts it.
  const srv1 = await bootServer({ OSMO_ADMIN_EMAIL: OPS });
  const a = client(srv1.base);
  assert.equal((await a.post('/api/auth/login', { identifier: OPS, passphrase: 'admin-test-pass-123' })).status, 200);
  srv1.stop();
  await new Promise((r) => setTimeout(r, 200));

  // A member holds the address the env names: it must NOT confer any role.
  const srv2 = await bootServer();
  const { c: theirs, user } = await registerMember(srv2.base, { email: OPS, fund: false });
  srv2.stop();
  await new Promise((r) => setTimeout(r, 200));

  const srv3 = await bootServer({ OSMO_DB: srv2.dbPath, OSMO_ADMIN_EMAIL: OPS, OSMO_ADMIN_PASS: 'would-be-console-pass' });
  t.after(() => srv3.stop());
  const c = client(srv3.base);
  // The member keeps their own role and their own passphrase.
  const theirLogin = await c.post('/api/auth/login', { identifier: OPS, passphrase: 'correct-horse-battery' });
  assert.equal(theirLogin.status, 200);
  assert.equal(theirLogin.json.user.role, 'member', 'holding the address must never grant admin');
  assert.equal(theirLogin.json.user.handle, user.handle);
  assert.equal((await c.get('/api/admin/overview')).status, 403);
  // The env password never landed on their account either.
  const impostor = await client(srv3.base).post('/api/auth/login', { identifier: OPS, passphrase: 'would-be-console-pass' });
  assert.equal(impostor.status, 401);
  // Their pre-existing session is untouched — nothing about them changed.
  const replay = await fetch(`${srv3.base}/api/me`, { headers: { Cookie: theirs.cookieValue() } });
  assert.equal(replay.status, 200);
  // The real operator is still reachable on its own handle.
  const seeded = await client(srv3.base).post('/api/auth/login', { identifier: 'admin', passphrase: 'would-be-console-pass' });
  assert.equal(seeded.status, 200);
  assert.equal(seeded.json.user.role, 'admin');
});

test('operator password sync: applies once, revokes on rotation, never claws back a self-chosen one', async (t) => {
  const srv1 = await bootServer({ OSMO_ADMIN_PASS: 'env-pass-one-11111' });
  const a = client(srv1.base);
  assert.equal((await a.post('/api/auth/login', { identifier: 'admin', passphrase: 'env-pass-one-11111' })).status, 200);
  srv1.stop();
  await new Promise((r) => setTimeout(r, 200));

  // Rotation: the new value applies and the old session is revoked.
  const srv2 = await bootServer({ OSMO_DB: srv1.dbPath, OSMO_ADMIN_PASS: 'env-pass-two-22222' });
  const b = client(srv2.base);
  assert.equal((await b.post('/api/auth/login', { identifier: 'admin', passphrase: 'env-pass-one-11111' })).status, 401,
    'the superseded password stops working');
  assert.equal((await b.post('/api/auth/login', { identifier: 'admin', passphrase: 'env-pass-two-22222' })).status, 200);
  const stale = await fetch(`${srv2.base}/api/me`, { headers: { Cookie: a.cookieValue() } });
  assert.equal(stale.status, 401, 'sessions from before the rotation are revoked');

  // The operator sets their own passphrase in the app.
  assert.equal((await b.post('/api/me/passphrase',
    { current: 'env-pass-two-22222', next: 'my-own-chosen-pass-33' })).status, 200);
  srv2.stop();
  await new Promise((r) => setTimeout(r, 200));

  // A cold start with the SAME env must not revert it.
  const srv3 = await bootServer({ OSMO_DB: srv1.dbPath, OSMO_ADMIN_PASS: 'env-pass-two-22222' });
  t.after(() => srv3.stop());
  const c = client(srv3.base);
  assert.equal((await c.post('/api/auth/login', { identifier: 'admin', passphrase: 'my-own-chosen-pass-33' })).status, 200,
    'a self-chosen passphrase survives cold starts');
  assert.equal((await client(srv3.base).post('/api/auth/login',
    { identifier: 'admin', passphrase: 'env-pass-two-22222' })).status, 401, 'the env value no longer works');
});

test('operator email: whitespace is normalised, an invalid value is ignored', async (t) => {
  const srv = await bootServer({ OSMO_ADMIN_EMAIL: '  OPS@Example.COM  ', OSMO_MANAGER_EMAIL: 'not-an-address' });
  t.after(() => srv.stop());
  const c = client(srv.base);
  assert.equal((await c.post('/api/auth/login', { identifier: 'ops@example.com', passphrase: 'admin-test-pass-123' })).status, 200,
    'trimmed + lowercased to match how addresses are stored');
  // The invalid manager address was ignored, leaving the seeded default intact.
  assert.equal((await client(srv.base).post('/api/auth/login',
    { identifier: 'marisol@osmo.money', passphrase: 'manager-test-pass-123' })).status, 200);
});

test('operator password: a database synced before the marker existed still keeps a self-chosen passphrase', async (t) => {
  // Boot 1 mimics a DB whose password was already applied by an older build:
  // the hash matches the env, but no marker was ever recorded.
  const srv1 = await bootServer({ OSMO_ADMIN_PASS: 'legacy-env-pass-4444' });
  const a = client(srv1.base);
  assert.equal((await a.post('/api/auth/login', { identifier: 'admin', passphrase: 'legacy-env-pass-4444' })).status, 200);
  await a.post('/api/me/passphrase', { current: 'legacy-env-pass-4444', next: 'operator-own-pass-55' });
  srv1.stop();
  await new Promise((r) => setTimeout(r, 200));

  const srv2 = await bootServer({ OSMO_DB: srv1.dbPath, OSMO_ADMIN_PASS: 'legacy-env-pass-4444' });
  t.after(() => srv2.stop());
  const c = client(srv2.base);
  assert.equal((await c.post('/api/auth/login', { identifier: 'admin', passphrase: 'operator-own-pass-55' })).status, 200,
    'their own passphrase survives');
  assert.equal((await client(srv2.base).post('/api/auth/login',
    { identifier: 'admin', passphrase: 'legacy-env-pass-4444' })).status, 401, 'the env value was not re-applied');
});
