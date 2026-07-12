import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember } from './helper.js';
import { totpNow } from '../server/lib/totp.js';

test('cards, 2FA, passkeys, gift store, and PDF/CSV export', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const B = srv.base;
  const { c, user } = await registerMember(B);

  await t.test('registration grants a virtual card', async () => {
    const r = await c.get('/api/cards');
    assert.equal(r.json.cards.length, 1);
    assert.match(r.json.cards[0].last4, /^\d{4}$/);
    assert.match(r.json.cards[0].exp, /^\d{2}\/\d{2}$/);
  });

  await t.test('card issue / freeze / limit / reveal', async () => {
    const issue = await c.post('/api/cards', { label: 'Travel', brand: 'VISA' });
    assert.equal(issue.status, 201);
    const cid = issue.json.card.id;
    const patch = await c.patch(`/api/cards/${cid}`, { frozen: true, dailyLimit: 500 });
    assert.equal(patch.json.card.frozen, true);
    assert.equal(patch.json.card.dailyLimit, 500);
    const reveal = await c.post(`/api/cards/${cid}/reveal`, { passphrase: 'correct-horse-battery' });
    assert.match(reveal.json.pan, /^\d{4} \d{4} \d{4} \d{4}$/);
    assert.match(reveal.json.cvv, /^\d{3}$/);
    assert.equal((await c.post(`/api/cards/${cid}/reveal`, { passphrase: 'wrong' })).status, 401);
  });

  await t.test('card ownership enforced', async () => {
    const other = (await registerMember(B)).c;
    const mine = (await c.get('/api/cards')).json.cards[0].id;
    assert.equal((await other.patch(`/api/cards/${mine}`, { frozen: true })).status, 403);
    assert.equal((await other.post(`/api/cards/${mine}/reveal`, { passphrase: 'x' })).status, 403);
  });

  await t.test('gift store debits USDC and returns a code', async () => {
    const b0 = (await c.get('/api/me')).json.balances.USDC;
    const g = await c.post('/api/cards/gift', { brand: 'SOLACE COFFEE', amount: 25 });
    assert.equal(g.status, 201);
    assert.match(g.json.gift.code, /^SOL-\d{4}-\d{4}-\d{4}$/);
    assert.equal(b0 - (await c.get('/api/me')).json.balances.USDC, 25);
    assert.equal((await c.post('/api/cards/gift', { brand: 'SOLACE COFFEE', amount: 999999 })).status, 400);
  });

  await t.test('2FA enroll + login step-up + disable', async () => {
    const setup = await c.post('/api/security/2fa/setup', {});
    assert.match(setup.json.secret, /^[A-Z2-7]+$/);
    assert.ok(setup.json.otpauthUri.startsWith('otpauth://'));
    assert.equal((await c.post('/api/security/2fa/enable', { code: '000000' })).status, 401);
    assert.equal((await c.post('/api/security/2fa/enable', { code: totpNow(setup.json.secret) })).json.twoFactorEnabled, true);

    const noCode = await client(B).post('/api/auth/login', { identifier: '@' + user.handle, passphrase: 'correct-horse-battery' });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.json.twoFactorRequired, true);
    const withCode = await client(B).post('/api/auth/login', { identifier: '@' + user.handle, passphrase: 'correct-horse-battery', totpCode: totpNow(setup.json.secret) });
    assert.equal(withCode.status, 200);
    assert.equal((await c.post('/api/security/2fa/disable', { code: totpNow(setup.json.secret) })).json.twoFactorEnabled, false);
  });

  await t.test('passkey ceremony options generate', async () => {
    const reg = await c.post('/api/security/passkey/register/options', {});
    assert.ok(reg.json.challenge && reg.json.rp.id === 'localhost');
    assert.ok(Array.isArray(reg.json.pubKeyCredParams) && reg.json.pubKeyCredParams.length);
    const login = await client(B).post('/api/auth/passkey/login/options', {});
    assert.ok(login.json.challenge);
  });

  await t.test('statement + edge export in CSV and PDF', async () => {
    const jar = c.cookieValue();
    const csv = await fetch(`${B}/api/reports/export?format=csv`, { headers: { Cookie: jar } });
    assert.ok(csv.headers.get('content-type').includes('text/csv'));
    const pdf = await fetch(`${B}/api/reports/export?format=pdf`, { headers: { Cookie: jar } });
    const buf = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
    assert.ok(buf.slice(-6).includes('EOF'));
    const edge = await fetch(`${B}/api/portfolio/export?format=pdf`, { headers: { Cookie: jar } });
    assert.ok((await edge.arrayBuffer()).byteLength > 500);
  });

  await t.test('new endpoints require auth', async () => {
    const anon = client(B);
    assert.equal((await anon.get('/api/cards')).status, 401);
    assert.equal((await anon.get('/api/security')).status, 401);
  });
});
