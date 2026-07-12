// Tests for server/routes/money.js — goals CRUD + internal/external transfers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootServer, client, registerMember } from './helper.js';

let srv;

before(async () => { srv = await bootServer(); });
after(() => srv.stop());

/**
 * bootServer hides its temp DB path, so locate our server's DB by scanning
 * osmo-* temp dirs for one containing a uniquely-named marker handle.
 */
function openDbContaining(handle) {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith('osmo-')) continue;
    let d = null;
    try {
      d = new DatabaseSync(join(tmpdir(), entry, 'test.db'));
      if (d.prepare('SELECT id FROM users WHERE handle = ?').get(handle)) return d;
      d.close();
    } catch {
      try { d?.close(); } catch { /* already closed */ }
    }
  }
  return null;
}

// ---- auth gates ------------------------------------------------------------

test('401 for every endpoint when unauthenticated', async () => {
  const anon = client(srv.base);
  const checks = [
    anon.get('/api/goals'),
    anon.post('/api/goals', { name: 'X', target: 100 }),
    anon.patch('/api/goals/1', { name: 'X' }),
    anon.del('/api/goals/1'),
    anon.post('/api/transfers', { to: 'rosa', amount: 10 }),
    anon.post('/api/transfers/record', { chain: 'eth', txid: 'a'.repeat(64), toAddress: '0xabc1', amount: 1, currency: 'ETH' }),
    anon.get('/api/transfers'),
  ];
  for (const r of await Promise.all(checks)) assert.equal(r.status, 401);
});

// ---- goals -----------------------------------------------------------------

test('goals: create with defaults and explicit fields, then list', async () => {
  const { c } = await registerMember(srv.base);

  const bare = await c.post('/api/goals', { name: 'Car', target: 800 });
  assert.equal(bare.status, 201);
  assert.equal(bare.json.goal.category, 'SAVINGS');
  assert.equal(bare.json.goal.icon, 'flag');
  assert.equal(bare.json.goal.saved, 0);
  assert.equal(bare.json.goal.autosave, 0);
  assert.equal(bare.json.goal.pct, 0);

  const full = await c.post('/api/goals', {
    name: 'Vacation Fund', target: 5000, category: 'travel', icon: 'plane', autosave: 120.55,
  });
  assert.equal(full.status, 201);
  assert.equal(full.json.goal.category, 'TRAVEL'); // normalized uppercase
  assert.equal(full.json.goal.icon, 'plane');
  assert.equal(full.json.goal.target, 5000);
  assert.equal(full.json.goal.autosave, 120.55);

  const list = await c.get('/api/goals');
  assert.equal(list.status, 200);
  assert.equal(list.json.goals.length, 2);
  assert.deepEqual(list.json.goals.map((g) => g.name), ['Car', 'Vacation Fund']);
});

test('goals: 400 on invalid input', async () => {
  const { c } = await registerMember(srv.base);
  assert.equal((await c.post('/api/goals', { target: 100 })).status, 400); // no name
  assert.equal((await c.post('/api/goals', { name: 'X', target: 0 })).status, 400);
  assert.equal((await c.post('/api/goals', { name: 'X', target: -5 })).status, 400);
  assert.equal((await c.post('/api/goals', { name: 'X', target: 'lots' })).status, 400);
  assert.equal((await c.post('/api/goals', { name: 'X', target: 100, autosave: -1 })).status, 400);

  const g = (await c.post('/api/goals', { name: 'X', target: 100 })).json.goal;
  assert.equal((await c.patch(`/api/goals/${g.id}`, {})).status, 400); // nothing to update
  assert.equal((await c.patch(`/api/goals/${g.id}`, { addSaved: 0 })).status, 400);
  assert.equal((await c.patch(`/api/goals/${g.id}`, { addSaved: -50 })).status, 400);
  assert.equal((await c.patch('/api/goals/abc', { name: 'Y' })).status, 400); // non-integer id
});

test('goals: addSaved debits USDC ledger and updates pct', async () => {
  const { c } = await registerMember(srv.base);
  const g = (await c.post('/api/goals', { name: 'House', target: 5000 })).json.goal;

  const r1 = await c.patch(`/api/goals/${g.id}`, { addSaved: 450 });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.goal.saved, 450);
  assert.equal(r1.json.goal.pct, 9);
  assert.equal((await c.get('/api/me')).json.balances.USDC, 12000); // 12450 - 450

  const r2 = await c.patch(`/api/goals/${g.id}`, { addSaved: 50.5 });
  assert.equal(r2.json.goal.saved, 500.5);
  assert.equal(r2.json.goal.pct, 10.01);
  assert.equal((await c.get('/api/me')).json.balances.USDC, 11949.5);
});

test('goals: addSaved with insufficient balance is rejected, nothing moves', async () => {
  const { c } = await registerMember(srv.base);
  const g = (await c.post('/api/goals', { name: 'Yacht', target: 999999 })).json.goal;

  const r = await c.patch(`/api/goals/${g.id}`, { addSaved: 999999 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /insufficient/i);
  assert.equal((await c.get('/api/me')).json.balances.USDC, 12450);
  assert.equal((await c.get('/api/goals')).json.goals[0].saved, 0);
});

test('goals: plain field updates via PATCH', async () => {
  const { c } = await registerMember(srv.base);
  const g = (await c.post('/api/goals', { name: 'Bike', target: 400 })).json.goal;
  const r = await c.patch(`/api/goals/${g.id}`, { name: 'E-Bike', target: 900, autosave: 25 });
  assert.equal(r.status, 200);
  assert.equal(r.json.goal.name, 'E-Bike');
  assert.equal(r.json.goal.target, 900);
  assert.equal(r.json.goal.autosave, 25);
});

test('goals: ownership enforced (403) and unknown id (404)', async () => {
  const { c: owner } = await registerMember(srv.base);
  const { c: intruder } = await registerMember(srv.base);
  const g = (await owner.post('/api/goals', { name: 'Private', target: 1000 })).json.goal;

  assert.equal((await intruder.patch(`/api/goals/${g.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await intruder.patch(`/api/goals/${g.id}`, { addSaved: 10 })).status, 403);
  assert.equal((await intruder.del(`/api/goals/${g.id}`)).status, 403);
  assert.equal((await intruder.get('/api/goals')).json.goals.length, 0); // list is scoped

  assert.equal((await owner.patch('/api/goals/999999', { name: 'Y' })).status, 404);
  assert.equal((await owner.del('/api/goals/999999')).status, 404);

  // Untouched by the intruder's attempts.
  const after = await owner.get('/api/goals');
  assert.equal(after.json.goals[0].name, 'Private');
  assert.equal(after.json.goals[0].saved, 0);
});

test('goals: delete refunds saved amount to ledger', async () => {
  const { c } = await registerMember(srv.base);
  const g = (await c.post('/api/goals', { name: 'Refundable', target: 1000 })).json.goal;
  await c.patch(`/api/goals/${g.id}`, { addSaved: 300 });
  assert.equal((await c.get('/api/me')).json.balances.USDC, 12150);

  const del = await c.del(`/api/goals/${g.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  assert.equal((await c.get('/api/me')).json.balances.USDC, 12450); // refunded
  assert.equal((await c.get('/api/goals')).json.goals.length, 0);
});

// ---- internal transfers ------------------------------------------------------

test('transfers: internal double-entry settle with counterparty handles', async () => {
  const { c: a, user: userA } = await registerMember(srv.base);
  const { c: b, user: userB } = await registerMember(srv.base);

  const r = await a.post('/api/transfers', { to: `@${userB.handle}`, amount: 250 });
  assert.equal(r.status, 201);
  assert.equal(r.json.transfer.status, 'settled');
  assert.equal(r.json.transfer.chain, 'internal');
  assert.equal(r.json.transfer.direction, 'out');
  assert.equal(r.json.transfer.counterparty, userB.handle);
  assert.equal(r.json.transfer.amount, 250);
  assert.equal(r.json.balance, 12200);

  assert.equal((await b.get('/api/me')).json.balances.USDC, 12700);

  // 2dp rounding on send; handle also accepted without '@'
  const r2 = await a.post('/api/transfers', { to: userB.handle, amount: 33.333 });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.transfer.amount, 33.33);
  assert.equal(r2.json.balance, 12166.67);

  // Recipient sees them inbound with the sender as counterparty.
  const inbox = await b.get('/api/transfers');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.transfers.length, 2);
  assert.equal(inbox.json.transfers[0].direction, 'in');
  assert.equal(inbox.json.transfers[0].counterparty, userA.handle);
});

test('transfers: OSM currency moves the OSM ledger', async () => {
  const { c: a } = await registerMember(srv.base);
  const { c: b, user: userB } = await registerMember(srv.base);

  const r = await a.post('/api/transfers', { to: userB.handle, amount: 4, currency: 'OSM' });
  assert.equal(r.status, 201);
  assert.equal(r.json.balance, 6); // seeded 10 OSM
  const meB = await b.get('/api/me');
  assert.equal(meB.json.balances.OSM, 14);
  assert.equal(meB.json.balances.USDC, 12450); // USDC untouched
});

test('transfers: self-send, unknown recipient, bad amounts', async () => {
  const { c, user } = await registerMember(srv.base);
  assert.equal((await c.post('/api/transfers', { to: user.handle, amount: 10 })).status, 400); // self
  assert.equal((await c.post('/api/transfers', { to: '@nobody_here_xyz', amount: 10 })).status, 404);
  assert.equal((await c.post('/api/transfers', { to: 'rosa', amount: 0 })).status, 400);
  assert.equal((await c.post('/api/transfers', { to: 'rosa', amount: -5 })).status, 400);
  assert.equal((await c.post('/api/transfers', { to: 'rosa', amount: 'ten' })).status, 400);
  assert.equal((await c.post('/api/transfers', { to: 'rosa', amount: 10, currency: 'EUR' })).status, 400);
  assert.equal((await c.post('/api/transfers', { amount: 10 })).status, 400); // no recipient
});

test('transfers: insufficient balance rejected atomically', async () => {
  const { c: a } = await registerMember(srv.base);
  const { c: b, user: userB } = await registerMember(srv.base);

  const r = await a.post('/api/transfers', { to: userB.handle, amount: 999999 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /insufficient/i);
  assert.equal((await a.get('/api/me')).json.balances.USDC, 12450);
  assert.equal((await b.get('/api/me')).json.balances.USDC, 12450);
  assert.equal((await a.get('/api/transfers')).json.transfers.length, 0); // no row recorded
});

test('transfers: frozen recipient is rejected', async () => {
  const { c: a } = await registerMember(srv.base);
  const marker = `frozen${Date.now()}`.slice(0, 24);
  await registerMember(srv.base, { handle: marker, email: `${marker}@example.com` });

  const d = openDbContaining(marker);
  assert.ok(d, 'could not locate the test server DB to freeze the recipient');
  d.prepare("UPDATE users SET status = 'frozen' WHERE handle = ?").run(marker);
  d.close();

  const r = await a.post('/api/transfers', { to: marker, amount: 10 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /frozen/i);
  assert.equal((await a.get('/api/me')).json.balances.USDC, 12450);
});

// ---- external (client-signed) sends -----------------------------------------

test('transfers/record: stores broadcast send without touching the ledger', async () => {
  const { c } = await registerMember(srv.base);
  const txid = `0x${'a1b2c3d4'.repeat(8)}`; // 64 hex chars, 0x-prefixed
  const r = await c.post('/api/transfers/record', {
    chain: 'eth-sepolia', txid, toAddress: `0x${'ab'.repeat(20)}`, amount: 75.25, currency: 'eth',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.transfer.status, 'broadcast');
  assert.equal(r.json.transfer.chain, 'eth-sepolia');
  assert.equal(r.json.transfer.direction, 'out');
  assert.equal(r.json.transfer.currency, 'ETH'); // normalized uppercase
  assert.equal(r.json.transfer.txid, txid);
  assert.equal(r.json.transfer.counterparty, null); // external → no handle
  assert.equal((await c.get('/api/me')).json.balances.USDC, 12450); // no ledger movement
});

test('transfers/record: validation failures', async () => {
  const { c } = await registerMember(srv.base);
  const good = {
    chain: 'btc-testnet', txid: 'deadbeef'.repeat(4), toAddress: 'tb1qexampleaddr0', amount: 5, currency: 'BTC',
  };
  assert.equal((await c.post('/api/transfers/record', good)).status, 201);
  assert.equal((await c.post('/api/transfers/record', { ...good, txid: 'zzzz-not-hex' })).status, 400);
  assert.equal((await c.post('/api/transfers/record', { ...good, txid: 'ab12' })).status, 400); // < 8 hex
  assert.equal((await c.post('/api/transfers/record', { ...good, txid: 'a'.repeat(130) })).status, 400); // > 128
  assert.equal((await c.post('/api/transfers/record', { ...good, chain: 'internal' })).status, 400);
  assert.equal((await c.post('/api/transfers/record', { ...good, chain: 'dogecoin' })).status, 400);
  assert.equal((await c.post('/api/transfers/record', { ...good, amount: 0 })).status, 400);
  assert.equal((await c.post('/api/transfers/record', { ...good, toAddress: undefined })).status, 400);
  assert.equal((await c.post('/api/transfers/record', { ...good, currency: undefined })).status, 400);
});

// ---- history -----------------------------------------------------------------

test('transfers: history is newest first, both directions', async () => {
  const { c: a, user: userA } = await registerMember(srv.base);
  const { c: b, user: userB } = await registerMember(srv.base);

  await a.post('/api/transfers', { to: userB.handle, amount: 10 });
  await b.post('/api/transfers', { to: userA.handle, amount: 5 });
  await a.post('/api/transfers/record', {
    chain: 'sol', txid: 'f00dfeed'.repeat(8), toAddress: 'So1anaAddre55Example', amount: 2, currency: 'SOL',
  });

  const r = await a.get('/api/transfers');
  assert.equal(r.status, 200);
  assert.equal(r.json.transfers.length, 3);
  const [ext, inn, out] = r.json.transfers;
  assert.ok(ext.id > inn.id && inn.id > out.id, 'newest first');
  assert.equal(ext.chain, 'sol');
  assert.equal(ext.direction, 'out');
  assert.equal(inn.direction, 'in');
  assert.equal(inn.counterparty, userB.handle);
  assert.equal(out.direction, 'out');
  assert.equal(out.counterparty, userB.handle);
});
