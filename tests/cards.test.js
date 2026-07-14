// Payment cards: issue / rename / freeze / limit / reveal (passphrase-gated),
// mobile-wallet provisioning (Apple / Google / Samsung), delete, and the
// gift-card store. Exercises ownership, validation, and the shared re-auth lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember } from './helper.js';

test('cards + wallet provisioning + gift store', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const base = srv.base;

  await t.test('a new member is issued a default card', async () => {
    const { c } = await registerMember(base, { fund: false });
    const r = await c.get('/api/cards');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.cards));
    assert.ok(r.json.cards.length >= 1, 'registration grants a starter card');
    const card = r.json.cards[0];
    assert.match(card.last4, /^\d{4}$/);
    assert.match(card.exp, /^\d{2}\/\d{2}$/);
    assert.equal(card.frozen, false);
    assert.ok(Array.isArray(card.wallets));
    // The list never leaks the full PAN or CVV.
    assert.equal(card.pan, undefined);
    assert.equal(card.cvv, undefined);
  });

  await t.test('issue, rename, freeze, and set a daily limit', async () => {
    const { c } = await registerMember(base, { fund: false });
    const issued = await c.post('/api/cards', { label: 'Travel', brand: 'VISA', kind: 'virtual' });
    assert.equal(issued.status, 201);
    const id = issued.json.card.id;
    assert.equal(issued.json.card.label, 'Travel');
    assert.equal(issued.json.card.brand, 'VISA');

    const renamed = await c.patch(`/api/cards/${id}`, { label: 'Groceries', dailyLimit: 500 });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.card.label, 'Groceries');
    assert.equal(renamed.json.card.dailyLimit, 500);

    const frozen = await c.patch(`/api/cards/${id}`, { frozen: true });
    assert.equal(frozen.status, 200);
    assert.equal(frozen.json.card.frozen, true);
  });

  await t.test('card mutations validate their inputs', async () => {
    const { c } = await registerMember(base, { fund: false });
    const id = (await c.get('/api/cards')).json.cards[0].id;
    assert.equal((await c.post('/api/cards', { brand: 'AMEX' })).status, 400); // unknown brand
    assert.equal((await c.post('/api/cards', { kind: 'metal' })).status, 400); // unknown kind
    assert.equal((await c.patch(`/api/cards/${id}`, {})).status, 400);          // nothing to update
    assert.equal((await c.patch(`/api/cards/${id}`, { dailyLimit: -5 })).status, 400);
    assert.equal((await c.patch(`/api/cards/${id}`, { label: '' })).status, 400);
  });

  await t.test('the 8-card ceiling is enforced', async () => {
    const { c } = await registerMember(base, { fund: false });
    const start = (await c.get('/api/cards')).json.cards.length;
    for (let i = start; i < 8; i++) assert.equal((await c.post('/api/cards', {})).status, 201);
    const over = await c.post('/api/cards', {});
    assert.equal(over.status, 409);
  });

  await t.test('reveal is passphrase-gated and returns the full PAN/CVV', async () => {
    const { c } = await registerMember(base, { fund: false });
    const id = (await c.get('/api/cards')).json.cards[0].id;
    assert.equal((await c.post(`/api/cards/${id}/reveal`, { passphrase: 'wrong-pass-here' })).status, 401);
    const ok = await c.post(`/api/cards/${id}/reveal`, { passphrase: 'correct-horse-battery' });
    assert.equal(ok.status, 200);
    assert.match(ok.json.pan.replace(/\s/g, ''), /^\d{16}$/);
    assert.match(ok.json.cvv, /^\d{3}$/);
    assert.match(ok.json.exp, /^\d{2}\/\d{2}$/);
  });

  await t.test('repeated wrong passphrases lock the shared re-auth budget', async () => {
    const { c } = await registerMember(base, { fund: false });
    const id = (await c.get('/api/cards')).json.cards[0].id;
    let sawLock = false;
    for (let i = 0; i < 8; i++) {
      const r = await c.post(`/api/cards/${id}/reveal`, { passphrase: 'nope-nope-nope' });
      if (r.status === 429) { sawLock = true; break; }
      assert.equal(r.status, 401);
    }
    assert.ok(sawLock, 'account locks out after repeated failures');
  });

  await t.test('cards are scoped to their owner', async () => {
    const { c: a } = await registerMember(base, { fund: false });
    const { c: b } = await registerMember(base, { fund: false });
    const aCard = (await a.get('/api/cards')).json.cards[0].id;
    assert.equal((await b.patch(`/api/cards/${aCard}`, { frozen: true })).status, 403);
    assert.equal((await b.post(`/api/cards/${aCard}/reveal`, { passphrase: 'correct-horse-battery' })).status, 403);
    assert.equal((await b.get('/api/cards')).json.cards.some((x) => x.id === aCard), false);
    assert.equal((await b.patch('/api/cards/99999', { frozen: true })).status, 404);
    assert.equal((await b.patch('/api/cards/abc', { frozen: true })).status, 400);
  });

  await t.test('provision a card to Apple / Google / Samsung wallets', async () => {
    const { c } = await registerMember(base, { fund: false });
    const id = (await c.get('/api/cards')).json.cards[0].id;
    for (const [platform, wallet] of [['apple', 'Apple Pay'], ['google', 'Google Pay'], ['samsung', 'Samsung Wallet']]) {
      const r = await c.post(`/api/cards/${id}/provision`, { platform, device: 'Pixel 9' });
      assert.equal(r.status, 201);
      assert.equal(r.json.platform, platform);
      assert.equal(r.json.wallet, wallet);
      assert.equal(r.json.simulated, true, 'issuer-side provisioning is honestly labelled');
      assert.ok(r.json.tokenRef && !/\d{12}/.test(r.json.tokenRef), 'token handle, never the real PAN');
    }
    // The card now advertises its three wallet tokens.
    const card = (await c.get('/api/cards')).json.cards.find((x) => x.id === id);
    assert.equal(card.wallets.length, 3);

    // Re-provisioning the same platform updates rather than duplicating.
    assert.equal((await c.post(`/api/cards/${id}/provision`, { platform: 'apple' })).status, 201);
    assert.equal((await c.get('/api/cards')).json.cards.find((x) => x.id === id).wallets.length, 3);

    // Unknown platform is rejected; removal works.
    assert.equal((await c.post(`/api/cards/${id}/provision`, { platform: 'paypal' })).status, 400);
    assert.equal((await c.del(`/api/cards/${id}/provision/apple`)).status, 200);
    assert.equal((await c.get('/api/cards')).json.cards.find((x) => x.id === id).wallets.length, 2);
  });

  await t.test('a frozen card cannot be added to a wallet', async () => {
    const { c } = await registerMember(base, { fund: false });
    const id = (await c.get('/api/cards')).json.cards[0].id;
    await c.patch(`/api/cards/${id}`, { frozen: true });
    assert.equal((await c.post(`/api/cards/${id}/provision`, { platform: 'apple' })).status, 409);
  });

  await t.test('deleting a card also drops its wallet tokens', async () => {
    const { c } = await registerMember(base, { fund: false });
    const issued = await c.post('/api/cards', { label: 'Disposable' });
    const id = issued.json.card.id;
    await c.post(`/api/cards/${id}/provision`, { platform: 'google' });
    assert.equal((await c.del(`/api/cards/${id}`)).status, 200);
    assert.equal((await c.get('/api/cards')).json.cards.some((x) => x.id === id), false);
    // A second delete is a clean 404 (already gone).
    assert.equal((await c.del(`/api/cards/${id}`)).status, 404);
  });

  await t.test('gift-card store debits USDC and lists purchases', async () => {
    const { c } = await registerMember(base); // funded: 12,450 USDC
    const buy = await c.post('/api/cards/gift', { brand: 'SOLACE COFFEE', amount: 25 });
    assert.equal(buy.status, 201);
    assert.equal(buy.json.gift.brand, 'SOLACE COFFEE');
    assert.equal(buy.json.gift.amount, 25);
    assert.ok(buy.json.gift.code);
    assert.equal(buy.json.balance, 12450 - 25);

    const gifts = await c.get('/api/cards/gifts');
    assert.equal(gifts.status, 200);
    assert.ok(gifts.json.gifts.some((g) => g.brand === 'SOLACE COFFEE' && g.amount === 25));
  });

  await t.test('gift-card store validates and rejects overspend', async () => {
    const { c } = await registerMember(base, { fund: false }); // zero balance
    assert.equal((await c.post('/api/cards/gift', { brand: 'NOPE', amount: 10 })).status, 400);
    assert.equal((await c.post('/api/cards/gift', { brand: 'AURORA AIR', amount: 0 })).status, 400);
    assert.equal((await c.post('/api/cards/gift', { brand: 'AURORA AIR', amount: 10 })).status, 400); // insufficient
  });

  await t.test('every card route requires a session', async () => {
    const anon = client(base);
    assert.equal((await anon.get('/api/cards')).status, 401);
    assert.equal((await anon.post('/api/cards', {})).status, 401);
    assert.equal((await anon.post('/api/cards/1/provision', { platform: 'apple' })).status, 401);
    assert.equal((await anon.get('/api/cards/gifts')).status, 401);
  });
});
