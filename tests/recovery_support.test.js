// Support tickets (contact form + admin inbox + auto-ticket on reset) and the two
// self-service recovery paths: card credential and recovery-phrase signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { bootServer, client, registerMember, loginAdmin } from './helper.js';

test('support + self-service recovery', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const base = srv.base;

  await t.test('contact form raises a ticket; admin reads and closes it', async () => {
    // anonymous visitor
    const anon = client(base);
    const r = await anon.post('/api/support', { category: 'troubleshooting', message: 'I cannot log in on my phone', email: 'visitor@example.com' });
    assert.equal(r.status, 201);
    assert.ok(r.json.ref);

    // member is scoped by their own account
    const { c } = await registerMember(base, { fund: false });
    assert.equal((await c.post('/api/support', { category: 'security', message: 'Please review my recent logins' })).status, 201);

    // members cannot read the inbox
    assert.equal((await c.get('/api/admin/support')).status, 403);

    // operator can
    const { c: admin } = await loginAdmin(base);
    const inbox = await admin.get('/api/admin/support');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.json.tickets.length >= 2);
    assert.ok(inbox.json.openCount >= 2);
    const id = inbox.json.tickets[0].id;
    assert.equal((await admin.patch(`/api/admin/support/${id}`, { status: 'closed' })).status, 200);
    const open = await admin.get('/api/admin/support?status=open');
    assert.ok(!open.json.tickets.some((tk) => tk.id === id), 'closed ticket leaves the open list');
  });

  await t.test('a password-reset request auto-notifies operators', async () => {
    const { user } = await registerMember(base, { fund: false });
    await client(base).post('/api/auth/forgot', { identifier: user.handle });
    const { c: admin } = await loginAdmin(base);
    const inbox = await admin.get('/api/admin/support?status=all');
    const sys = inbox.json.tickets.find((tk) => tk.source === 'system' && tk.userHandle === user.handle);
    assert.ok(sys, 'a system password_reset ticket exists');
    assert.equal(sys.category, 'password_reset');
  });

  await t.test('recover via card credential → reset token → new passphrase', async () => {
    const { c, user } = await registerMember(base, { fund: false });
    const cards = (await c.get('/api/cards')).json.cards;
    const revealed = (await c.post(`/api/cards/${cards[0].id}/reveal`, { passphrase: 'correct-horse-battery' })).json;
    const pan = String(revealed.pan).replace(/\D/g, '');
    const anon = client(base);

    // wrong CVV is rejected
    assert.equal((await anon.post('/api/auth/recover/card', { identifier: user.handle, pan, exp: revealed.exp, cvv: '000' })).status, 400);
    // correct details yield a reset token
    const ok = await anon.post('/api/auth/recover/card', { identifier: user.handle, pan, exp: revealed.exp, cvv: revealed.cvv });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.resetToken);
    // token drives the normal reset path
    assert.equal((await anon.post('/api/auth/reset', { token: ok.json.resetToken, next: 'card-recovered-pass-1' })).status, 200);
    const fresh = client(base);
    assert.equal((await fresh.post('/api/auth/login', { identifier: user.handle, passphrase: 'card-recovered-pass-1' })).status, 200);
  });

  await t.test('recover via recovery-phrase signature → reset token → new passphrase', async () => {
    const { c, user } = await registerMember(base, { fund: false });
    // Anchor an ETH wallet address for this account (the UI does this at signup).
    const w = Wallet.createRandom();
    assert.equal((await c.post('/api/wallets', { chain: 'eth', address: w.address, label: 'Primary', kind: 'hd' })).status, 201);

    const anon = client(base);
    const nonce = (await anon.post('/api/auth/recover/challenge', {})).json.nonce;
    assert.ok(nonce);

    // wrong key (different wallet) is rejected
    const wrongSig = await Wallet.createRandom().signMessage(nonce);
    assert.equal((await anon.post('/api/auth/recover/seed', { identifier: user.handle, nonce, signature: wrongSig })).status, 400);

    // correct key signs the same nonce → but the nonce was consumed; get a fresh one
    const nonce2 = (await anon.post('/api/auth/recover/challenge', {})).json.nonce;
    const sig = await w.signMessage(nonce2);
    const ok = await anon.post('/api/auth/recover/seed', { identifier: user.handle, nonce: nonce2, signature: sig });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.resetToken);
    assert.equal((await anon.post('/api/auth/reset', { token: ok.json.resetToken, next: 'seed-recovered-pass-1' })).status, 200);
    const fresh = client(base);
    assert.equal((await fresh.post('/api/auth/login', { identifier: user.handle, passphrase: 'seed-recovered-pass-1' })).status, 200);
  });

  await t.test('recovery challenge nonce is single-use', async () => {
    const { c, user } = await registerMember(base, { fund: false });
    const w = Wallet.createRandom();
    await c.post('/api/wallets', { chain: 'eth', address: w.address, label: 'Primary', kind: 'hd' });
    const anon = client(base);
    const nonce = (await anon.post('/api/auth/recover/challenge', {})).json.nonce;
    const sig = await w.signMessage(nonce);
    assert.equal((await anon.post('/api/auth/recover/seed', { identifier: user.handle, nonce, signature: sig })).status, 200);
    // replaying the same nonce fails (challenge consumed)
    assert.equal((await anon.post('/api/auth/recover/seed', { identifier: user.handle, nonce, signature: sig })).status, 400);
  });
});
