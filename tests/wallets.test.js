import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember } from './helper.js';

// Known-good address fixtures per chain shape.
const ETH_ADDR = '0x1111111111111111111111111111111111111111';
const ETH_ADDR_2 = '0xAbCdEf0123456789aBcDeF0123456789abcdef01'; // mixed-case checksum style
const BTC_BECH32 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const BTC_BASE58 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const SOL_ADDR = 'So11111111111111111111111111111111111111112';

let srv;
let base;

before(async () => {
  srv = await bootServer();
  base = srv.base;
});

after(() => srv.stop());

test('401 unauthenticated on every wallets endpoint', async () => {
  const anon = client(base);
  assert.equal((await anon.get('/api/wallets')).status, 401);
  assert.equal((await anon.post('/api/wallets', { chain: 'eth', address: ETH_ADDR })).status, 401);
  assert.equal((await anon.patch('/api/wallets/1', { label: 'x' })).status, 401);
  assert.equal((await anon.del('/api/wallets/1')).status, 401);
});

test('fresh member starts with an empty registry', async () => {
  const { c } = await registerMember(base);
  const r = await c.get('/api/wallets');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.wallets, []);
});

test('POST registers a wallet and GET lists it with camelCase shape', async () => {
  const { c } = await registerMember(base);
  const r = await c.post('/api/wallets', { chain: 'eth-sepolia', address: ETH_ADDR, label: 'Main hot wallet' });
  assert.equal(r.status, 201);
  const w = r.json.wallet;
  assert.equal(typeof w.id, 'number');
  assert.equal(w.chain, 'eth-sepolia');
  assert.equal(w.address, ETH_ADDR);
  assert.equal(w.label, 'Main hot wallet');
  assert.equal(w.kind, 'hd'); // schema default when kind omitted
  assert.ok(w.createdAt);
  assert.deepEqual(Object.keys(w).sort(), ['address', 'chain', 'createdAt', 'id', 'kind', 'label']);

  const list = await c.get('/api/wallets');
  assert.equal(list.status, 200);
  assert.equal(list.json.wallets.length, 1);
  assert.deepEqual(list.json.wallets[0], w);
});

test('accepts valid shapes on every chain', async () => {
  const { c } = await registerMember(base);
  const cases = [
    ['btc-testnet', BTC_BECH32],
    ['btc', BTC_BASE58],
    ['eth', ETH_ADDR_2],
    ['eth-sepolia', ETH_ADDR],
    ['sol', SOL_ADDR],
    ['usdc', ETH_ADDR], // USDC is an ERC-20 → EVM address shape
  ];
  for (const [chain, address] of cases) {
    const r = await c.post('/api/wallets', { chain, address, kind: 'watch' });
    assert.equal(r.status, 201, `${chain} should accept ${address}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.wallet.kind, 'watch');
  }
  const list = await c.get('/api/wallets');
  assert.equal(list.json.wallets.length, cases.length);
});

test('400 on validation failures', async () => {
  const { c } = await registerMember(base);
  const bad = [
    [{ chain: 'doge', address: ETH_ADDR }, 'unknown chain'],
    [{ address: ETH_ADDR }, 'missing chain'],
    [{ chain: 'eth' }, 'missing address'],
    [{ chain: 'eth', address: 42 }, 'non-string address'],
    [{ chain: 'eth', address: ETH_ADDR.slice(2) }, 'eth without 0x prefix'],
    [{ chain: 'eth', address: '0x1234' }, 'eth too short'],
    [{ chain: 'eth', address: '0x' + 'g'.repeat(40) }, 'eth non-hex'],
    [{ chain: 'eth', address: '0x' + 'a'.repeat(200) }, 'address over 128 chars'],
    [{ chain: 'sol', address: 'abc123' }, 'sol too short'],
    [{ chain: 'sol', address: '0'.repeat(40) }, 'sol invalid base58 charset (0)'],
    [{ chain: 'sol', address: 'l'.repeat(50) }, 'sol too long / invalid charset'],
    [{ chain: 'btc', address: 'O0Il'.repeat(10) }, 'btc invalid base58 charset'],
    [{ chain: 'btc-testnet', address: 'tb1' }, 'bech32 too short'],
    [{ chain: 'eth', address: ETH_ADDR, kind: 'cold' }, 'unknown kind'],
    [{ chain: 'eth', address: ETH_ADDR, label: '' }, 'empty label'],
    [{ chain: 'eth', address: ETH_ADDR, label: 'x'.repeat(61) }, 'label too long'],
  ];
  for (const [body, why] of bad) {
    const r = await c.post('/api/wallets', body);
    assert.equal(r.status, 400, `expected 400 for ${why}, got ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(r.json.error, `error message for ${why}`);
  }
});

test('409 on duplicate (same user, chain, address); other users unaffected', async () => {
  const { c: a } = await registerMember(base);
  const { c: b } = await registerMember(base);
  assert.equal((await a.post('/api/wallets', { chain: 'btc', address: BTC_BASE58 })).status, 201);
  const dup = await a.post('/api/wallets', { chain: 'btc', address: BTC_BASE58 });
  assert.equal(dup.status, 409);
  // Same address on a different chain is a distinct row.
  assert.equal((await a.post('/api/wallets', { chain: 'btc-testnet', address: BTC_BASE58 })).status, 201);
  // A different user may register the same address.
  assert.equal((await b.post('/api/wallets', { chain: 'btc', address: BTC_BASE58 })).status, 201);
});

test('PATCH relabels own wallet only, and validates label', async () => {
  const { c } = await registerMember(base);
  const created = (await c.post('/api/wallets', { chain: 'sol', address: SOL_ADDR, label: 'before' })).json.wallet;

  const r = await c.patch(`/api/wallets/${created.id}`, { label: 'after' });
  assert.equal(r.status, 200);
  assert.equal(r.json.wallet.label, 'after');
  assert.equal(r.json.wallet.address, SOL_ADDR); // untouched
  assert.equal(r.json.wallet.chain, 'sol');
  assert.equal(r.json.wallet.kind, created.kind);

  assert.equal((await c.patch(`/api/wallets/${created.id}`, {})).status, 400);
  assert.equal((await c.patch(`/api/wallets/${created.id}`, { label: '' })).status, 400);
  assert.equal((await c.patch(`/api/wallets/${created.id}`, { label: 'x'.repeat(61) })).status, 400);
});

test('403 on another member\'s wallet; wallets never leak across users', async () => {
  const { c: owner } = await registerMember(base);
  const { c: intruder } = await registerMember(base);
  const wallet = (await owner.post('/api/wallets', { chain: 'eth', address: ETH_ADDR })).json.wallet;

  assert.equal((await intruder.patch(`/api/wallets/${wallet.id}`, { label: 'mine now' })).status, 403);
  assert.equal((await intruder.del(`/api/wallets/${wallet.id}`)).status, 403);

  const list = await intruder.get('/api/wallets');
  assert.deepEqual(list.json.wallets, []);

  // Owner's wallet is untouched.
  const still = (await owner.get('/api/wallets')).json.wallets;
  assert.equal(still.length, 1);
  assert.equal(still[0].label, wallet.label);
});

test('404 unknown id, 400 non-numeric id', async () => {
  const { c } = await registerMember(base);
  assert.equal((await c.patch('/api/wallets/999999', { label: 'x' })).status, 404);
  assert.equal((await c.del('/api/wallets/999999')).status, 404);
  assert.equal((await c.patch('/api/wallets/abc', { label: 'x' })).status, 400);
  assert.equal((await c.del('/api/wallets/abc')).status, 400);
  assert.equal((await c.del('/api/wallets/0')).status, 400);
});

test('DELETE removes the wallet and frees the (chain,address) slot', async () => {
  const { c } = await registerMember(base);
  const wallet = (await c.post('/api/wallets', { chain: 'btc-testnet', address: BTC_BECH32 })).json.wallet;

  const del = await c.del(`/api/wallets/${wallet.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { ok: true });

  assert.deepEqual((await c.get('/api/wallets')).json.wallets, []);
  assert.equal((await c.del(`/api/wallets/${wallet.id}`)).status, 404);

  // Re-registering the same chain+address after delete works again.
  assert.equal((await c.post('/api/wallets', { chain: 'btc-testnet', address: BTC_BECH32 })).status, 201);
});

test('newest wallet is listed first', async () => {
  const { c } = await registerMember(base);
  await c.post('/api/wallets', { chain: 'eth', address: ETH_ADDR, label: 'first' });
  await c.post('/api/wallets', { chain: 'sol', address: SOL_ADDR, label: 'second' });
  const list = (await c.get('/api/wallets')).json.wallets;
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'second');
  assert.equal(list[1].label, 'first');
});
