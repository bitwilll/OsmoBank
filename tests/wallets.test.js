import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember } from './helper.js';

// Known-good address fixtures per chain shape.
const ETH_ADDR = '0x1111111111111111111111111111111111111111';
const ETH_ADDR_2 = '0xAbCdEf0123456789aBcDeF0123456789abcdef01'; // mixed-case checksum style
const BTC_MAIN_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // BIP-173 mainnet example
const BTC_TEST_BECH32 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'; // BIP-173 testnet example
const BTC_MAIN_BASE58 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';         // mainnet P2PKH (1…)
const BTC_MAIN_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';           // mainnet P2SH (3…)
const BTC_TEST_BASE58 = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';         // testnet P2PKH (m…)
const BTC_TEST_P2SH = '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc';          // testnet P2SH (2…)
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
    ['btc', BTC_MAIN_BECH32],
    ['btc', BTC_MAIN_BASE58],
    ['btc', BTC_MAIN_P2SH],
    ['btc-testnet', BTC_TEST_BECH32],
    ['btc-testnet', BTC_TEST_BASE58],
    ['btc-testnet', BTC_TEST_P2SH],
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
    [{ chain: 'eth', address: '0x' + 'a'.repeat(39) + '\u0000' }, 'eth with embedded NUL'],
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

// Regression (finding 1): btc and btc-testnet are distinct networks — a
// mainnet-shaped address must not register under btc-testnet or vice versa.
test('rejects wrong-network BTC addresses per chain', async () => {
  const { c } = await registerMember(base);
  const crossNetwork = [
    [{ chain: 'btc', address: BTC_TEST_BECH32 }, 'tb1 bech32 on mainnet'],
    [{ chain: 'btc', address: BTC_TEST_BASE58 }, 'testnet m… base58 on mainnet'],
    [{ chain: 'btc', address: BTC_TEST_P2SH }, 'testnet 2… base58 on mainnet'],
    [{ chain: 'btc-testnet', address: BTC_MAIN_BECH32 }, 'bc1 bech32 on testnet'],
    [{ chain: 'btc-testnet', address: BTC_MAIN_BASE58 }, 'mainnet 1… base58 on testnet'],
    [{ chain: 'btc-testnet', address: BTC_MAIN_P2SH }, 'mainnet 3… base58 on testnet'],
    // bc1-prefixed but invalid bech32 data charset — must not slip through the base58 branch
    [{ chain: 'btc', address: 'bc1bio' + 'q'.repeat(25) }, 'bc1 prefix with non-bech32 payload'],
    [{ chain: 'btc-testnet', address: 'tb1bio' + 'q'.repeat(25) }, 'tb1 prefix with non-bech32 payload'],
  ];
  for (const [body, why] of crossNetwork) {
    const r = await c.post('/api/wallets', body);
    assert.equal(r.status, 400, `expected 400 for ${why}, got ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(r.json.error, `error message for ${why}`);
  }
  // Nothing was persisted by the rejected attempts.
  assert.deepEqual((await c.get('/api/wallets')).json.wallets, []);
});

test('409 on duplicate (same user, chain, address); other users unaffected', async () => {
  const { c: a } = await registerMember(base);
  const { c: b } = await registerMember(base);
  assert.equal((await a.post('/api/wallets', { chain: 'btc', address: BTC_MAIN_BASE58 })).status, 201);
  const dup = await a.post('/api/wallets', { chain: 'btc', address: BTC_MAIN_BASE58 });
  assert.equal(dup.status, 409);
  // Same address on a different chain is a distinct row (eth and usdc share the EVM shape).
  assert.equal((await a.post('/api/wallets', { chain: 'eth', address: ETH_ADDR })).status, 201);
  assert.equal((await a.post('/api/wallets', { chain: 'usdc', address: ETH_ADDR })).status, 201);
  // A different user may register the same address.
  assert.equal((await b.post('/api/wallets', { chain: 'btc', address: BTC_MAIN_BASE58 })).status, 201);
});

// Regression (finding 2): EVM addresses are case-insensitive (EIP-55 casing is
// only a checksum), so the same account must not register twice under two casings.
test('EVM duplicate check is case-insensitive; addresses stored lowercase', async () => {
  const { c } = await registerMember(base);
  const lower = '0xabcdef0123456789abcdef0123456789abcdef01';

  assert.equal((await c.post('/api/wallets', { chain: 'eth', address: lower })).status, 201);
  for (const recased of [lower.toUpperCase().replace('0X', '0x'), ETH_ADDR_2]) {
    const dup = await c.post('/api/wallets', { chain: 'eth', address: recased });
    assert.equal(dup.status, 409, `expected 409 for recased duplicate ${recased}: ${JSON.stringify(dup.json)}`);
  }
  let list = (await c.get('/api/wallets')).json.wallets;
  assert.equal(list.length, 1, 'only one wallet row for the same logical EVM account');
  assert.equal(list[0].address, lower);

  // Mixed-case submissions on every EVM chain are normalized to lowercase.
  for (const chain of ['eth-sepolia', 'usdc']) {
    const r = await c.post('/api/wallets', { chain, address: ETH_ADDR_2 });
    assert.equal(r.status, 201);
    assert.equal(r.json.wallet.address, ETH_ADDR_2.toLowerCase(), `${chain} address normalized`);
    const dup = await c.post('/api/wallets', { chain, address: ETH_ADDR_2.toLowerCase() });
    assert.equal(dup.status, 409, `${chain} lowercase resubmission is a duplicate`);
  }

  // base58 chains are case-SENSITIVE — sol/btc addresses must be stored as submitted.
  const sol = await c.post('/api/wallets', { chain: 'sol', address: SOL_ADDR });
  assert.equal(sol.status, 201);
  assert.equal(sol.json.wallet.address, SOL_ADDR);
  const btc = await c.post('/api/wallets', { chain: 'btc', address: BTC_MAIN_P2SH });
  assert.equal(btc.status, 201);
  assert.equal(btc.json.wallet.address, BTC_MAIN_P2SH);
});

// Regression (finding 3): node:sqlite truncates TEXT bindings at an embedded
// NUL byte, so control characters in labels must be rejected, not persisted.
test('400 on labels containing NUL or other control characters', async () => {
  const { c } = await registerMember(base);
  const badLabels = [
    ['safe\u0000; DROP TABLE wallets; --', 'embedded NUL'],
    ['x\u0000hidden', 'NUL mid-string'],
    ['line1\nline2', 'embedded newline'],
    ['tab\there', 'embedded tab'],
    ['del\u007fchar', 'embedded DEL'],
    ['\u0000', 'lone NUL'],
  ];
  for (const [label, why] of badLabels) {
    const r = await c.post('/api/wallets', { chain: 'eth', address: ETH_ADDR, label });
    assert.equal(r.status, 400, `POST expected 400 for ${why}, got ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(r.json.error, `error message for ${why}`);
  }
  // No wallet was created by any rejected attempt.
  assert.deepEqual((await c.get('/api/wallets')).json.wallets, []);

  const wallet = (await c.post('/api/wallets', { chain: 'eth', address: ETH_ADDR, label: 'clean' })).json.wallet;
  for (const [label, why] of badLabels) {
    const r = await c.patch(`/api/wallets/${wallet.id}`, { label });
    assert.equal(r.status, 400, `PATCH expected 400 for ${why}, got ${r.status} ${JSON.stringify(r.json)}`);
  }
  // Label untouched by the rejected PATCHes; a sane label still works.
  assert.equal((await c.get('/api/wallets')).json.wallets[0].label, 'clean');
  const ok = await c.patch(`/api/wallets/${wallet.id}`, { label: 'still fine' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.wallet.label, 'still fine');
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
  const wallet = (await c.post('/api/wallets', { chain: 'btc-testnet', address: BTC_TEST_BECH32 })).json.wallet;

  const del = await c.del(`/api/wallets/${wallet.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { ok: true });

  assert.deepEqual((await c.get('/api/wallets')).json.wallets, []);
  assert.equal((await c.del(`/api/wallets/${wallet.id}`)).status, 404);

  // Re-registering the same chain+address after delete works again.
  assert.equal((await c.post('/api/wallets', { chain: 'btc-testnet', address: BTC_TEST_BECH32 })).status, 201);
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
