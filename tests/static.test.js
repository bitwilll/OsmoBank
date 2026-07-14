// The static frontend and the cross-cutting HTTP surface: asset serving, the
// security-header set, the CSRF / same-origin guards, JSON-body enforcement,
// and the shape of API 404 / 401 / parse errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from './helper.js';

test('static assets + security headers + request guards', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const base = srv.base;

  await t.test('serves the SPA shell at /', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const html = await r.text();
    assert.match(html, /OsmoBank/);
    assert.match(html, /id="ob-root"/);
  });

  await t.test('serves the app bundle, styles, and a partial', async () => {
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') || '', /css/);

    const partial = await fetch(`${base}/partials/login.html`);
    assert.equal(partial.status, 200);
    assert.match(await partial.text(), /Unlock/);
  });

  await t.test('every response carries the hardening headers', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=63072000/);
    assert.match(r.headers.get('permissions-policy') || '', /publickey-credentials-get=\(self\)/);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /upgrade-insecure-requests/);
    // The framework fingerprint is suppressed.
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  await t.test('unknown API routes return a JSON 404', async () => {
    const r = await fetch(`${base}/api/does-not-exist`);
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.ok(body.error);
  });

  await t.test('protected API without a session is 401', async () => {
    const r = await fetch(`${base}/api/me`);
    assert.equal(r.status, 401);
  });

  await t.test('a cross-origin state-changing request is rejected', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ identifier: 'x', passphrase: 'y' }),
    });
    assert.equal(r.status, 403);
  });

  await t.test('a cross-site fetch (Sec-Fetch-Site) is rejected', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ identifier: 'x', passphrase: 'y' }),
    });
    assert.equal(r.status, 403);
  });

  await t.test('same-origin POST passes the CSRF guard (401 for bad creds, not 403)', async () => {
    const host = new URL(base).host;
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Host: host, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ identifier: 'nobody@example.com', passphrase: 'whatever-nope' }),
    });
    assert.notEqual(r.status, 403);
    assert.equal(r.status, 401);
  });

  await t.test('a non-JSON body on an API POST is 415', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'identifier=x',
    });
    assert.equal(r.status, 415);
  });

  await t.test('malformed JSON is a clean 400, not a 500', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    assert.equal(r.status, 400);
  });

  await t.test('an oversized JSON body is rejected (64kb limit)', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'a'.repeat(70 * 1024) }),
    });
    assert.ok(r.status === 413 || r.status === 400, `expected 413/400, got ${r.status}`);
  });
});
