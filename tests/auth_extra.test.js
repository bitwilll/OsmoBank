// Forgot/reset passphrase, single-active-session signalling, and mobile-wallet
// provisioning. Runs against the real server with a temp DB (dev mode, so the
// forgot endpoint reveals the reset token to the client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember } from './helper.js';

test('auth: sessions, forgot/reset, wallet provisioning', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const base = srv.base;

  await t.test('single-active-session status + logout-all', async () => {
    const { c: a, user } = await registerMember(base, { fund: false });
    let me = (await a.get('/api/me')).json;
    assert.equal(me.session.others, 0);
    assert.equal(me.session.othersLive, 0);

    // Same account signs in from a second device.
    const b = client(base);
    const lb = await b.post('/api/auth/login', { identifier: user.handle, passphrase: 'correct-horse-battery' });
    assert.equal(lb.status, 200);

    me = (await a.get('/api/me')).json;
    assert.equal(me.session.others, 1);
    assert.equal(me.session.othersLive, 1, 'the second device is live');

    const sessions = (await a.get('/api/sessions')).json.sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((s) => s.current).length, 1, 'exactly one current session');

    const revoke = await a.post('/api/auth/logout-all');
    assert.equal(revoke.status, 200);
    assert.equal(revoke.json.revoked, 1);
    assert.equal((await a.get('/api/me')).json.session.others, 0, 'no other sessions remain');
    assert.equal((await b.get('/api/me')).status, 401, 'second device was signed out');
  });

  await t.test('reset: single-use token rotates passphrase and revokes every session', async () => {
    const { c, user } = await registerMember(base, { fund: false });
    assert.equal((await c.get('/api/me')).status, 200);

    const anon = client(base);
    const forgot = await anon.post('/api/auth/forgot', { identifier: user.handle });
    assert.equal(forgot.status, 200);
    assert.equal(forgot.json.ok, true);
    const token = forgot.json.devToken;
    assert.ok(token, 'dev mode reveals the reset token');

    assert.equal((await anon.post('/api/auth/reset', { token, next: 'short' })).status, 400, 'weak passphrase rejected');
    assert.equal((await anon.post('/api/auth/reset', { token, next: 'brand-new-passphrase-1' })).status, 200);
    assert.equal((await anon.post('/api/auth/reset', { token, next: 'yet-another-pass-22' })).status, 400, 'token is single-use');

    assert.equal((await c.get('/api/me')).status, 401, 'reset revoked the original session');
    const fresh = client(base);
    assert.equal((await fresh.post('/api/auth/login', { identifier: user.handle, passphrase: 'correct-horse-battery' })).status, 401, 'old passphrase no longer works');
    assert.equal((await fresh.post('/api/auth/login', { identifier: user.handle, passphrase: 'brand-new-passphrase-1' })).status, 200, 'new passphrase works');
  });

  await t.test('forgot cooldown: a rapid re-request does not mint a second token', async () => {
    const { user } = await registerMember(base, { fund: false });
    const anon = client(base);
    const first = await anon.post('/api/auth/forgot', { identifier: user.handle });
    assert.ok(first.json.devToken, 'first request mints a token');
    const second = await anon.post('/api/auth/forgot', { identifier: user.handle });
    assert.equal(second.status, 200);
    assert.equal(second.json.ok, true);
    assert.equal(second.json.devToken, undefined, 'second request within cooldown mints nothing (no victim-token-invalidation DoS)');
  });

  await t.test('passphrase change invalidates a pending reset token', async () => {
    const { c, user } = await registerMember(base, { fund: false });
    const anon = client(base);
    const token = (await anon.post('/api/auth/forgot', { identifier: user.handle })).json.devToken;
    assert.ok(token);
    const chg = await c.post('/api/me/passphrase', { current: 'correct-horse-battery', next: 'rotated-passphrase-77' });
    assert.equal(chg.status, 200);
    assert.equal((await anon.post('/api/auth/reset', { token, next: 'attacker-chosen-pass-1' })).status, 400, 'stale reset token cannot survive a credential change');
  });

  await t.test('forgot does not enumerate accounts', async () => {
    const anon = client(base);
    const unknown = await anon.post('/api/auth/forgot', { identifier: 'ghost@nowhere.zzz' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.ok, true);
    assert.equal(unknown.json.devToken, undefined, 'no token minted for an unknown account');
  });

  await t.test('mobile-wallet provisioning (apple/google/samsung)', async () => {
    const { c } = await registerMember(base, { fund: false });
    const cards = (await c.get('/api/cards')).json.cards;
    const id = cards[0].id;
    assert.deepEqual(cards[0].wallets, [], 'new card is in no wallet');

    const prov = await c.post(`/api/cards/${id}/provision`, { platform: 'apple', device: 'iPhone 15' });
    assert.equal(prov.status, 201);
    assert.equal(prov.json.wallet, 'Apple Pay');
    assert.equal(prov.json.simulated, true);
    assert.ok(String(prov.json.tokenRef).startsWith(cards[0].last4), 'token references the card last4, not the PAN');

    assert.equal((await c.post(`/api/cards/${id}/provision`, { platform: 'paypal' })).status, 400, 'unknown platform rejected');

    let wallets = (await c.get('/api/cards')).json.cards[0].wallets.map((w) => w.platform);
    assert.deepEqual(wallets, ['apple']);

    // Re-provisioning the same platform is idempotent (one row per card+platform).
    await c.post(`/api/cards/${id}/provision`, { platform: 'apple' });
    assert.equal((await c.get('/api/cards')).json.cards[0].wallets.length, 1);

    assert.equal((await c.del(`/api/cards/${id}/provision/apple`)).status, 200);
    assert.equal((await c.get('/api/cards')).json.cards[0].wallets.length, 0, 'removed from wallet');
  });
});
