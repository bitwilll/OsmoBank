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
