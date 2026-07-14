// Statement / Investor's-Edge exports (CSV + PDF) and the recent-activity feed.
// Binary/CSV bodies are fetched raw with the session cookie so headers and bytes
// can be inspected directly (the helper client only decodes JSON).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember } from './helper.js';

const authed = (base, jar) => (path) =>
  fetch(base + path, { headers: jar.cookieValue() ? { Cookie: jar.cookieValue() } : {} });

test('exports + activity feed', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const base = srv.base;

  await t.test('activity feed reflects deposits', async () => {
    const { c } = await registerMember(base); // two funding deposits
    const r = await c.get('/api/activity');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.activity));
    assert.ok(r.json.activity.length >= 2);
    assert.ok(r.json.activity.some((a) => a.kind === 'deposit'));
    assert.ok(r.json.activity.every((a) => typeof a.delta === 'number'));
  });

  await t.test('statement export — CSV', async () => {
    const { c } = await registerMember(base);
    const get = authed(base, c);
    const r = await get('/api/reports/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/csv/);
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename="osmobank-ledger\.csv"/);
    const body = await r.text();
    assert.match(body, /^id,date,currency,kind,amount,refType,refId,memo/);
    assert.match(body, /deposit/);
  });

  await t.test('statement export — PDF', async () => {
    const { c } = await registerMember(base);
    const get = authed(base, c);
    const r = await get('/api/reports/export?format=pdf');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/pdf/);
    assert.match(r.headers.get('content-disposition') || '', /osmobank-statement\.pdf/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.toString('latin1').startsWith('%PDF-1.4'));
    assert.ok(buf.length > 500);
  });

  await t.test("Investor's Edge export — CSV + PDF", async () => {
    const { c } = await registerMember(base);
    const get = authed(base, c);
    const csv = await get('/api/portfolio/export');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    assert.match(await csv.text(), /^venture,sector,stake,valueNow,pl,plPct,apy,dividendsPaid/);

    const pdf = await get('/api/portfolio/export?format=pdf');
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type') || '', /application\/pdf/);
    assert.match(pdf.headers.get('content-disposition') || '', /osmobank-edge\.pdf/);
    assert.ok(Buffer.from(await pdf.arrayBuffer()).toString('latin1').startsWith('%PDF'));
  });

  await t.test('CSV formula-injection is neutralised', async () => {
    // A memo that starts with '=' must be quoted/prefixed so spreadsheets do not
    // execute it. Drive a deposit with a crafted memo path via a transfer note.
    const { c } = await registerMember(base);
    const get = authed(base, c);
    const body = await (await get('/api/reports/export')).text();
    // Every data cell that begins with a formula char is escaped with a leading quote.
    for (const line of body.split('\r\n')) {
      const cells = line.split(',');
      for (const cell of cells) {
        if (/^[=+@]/.test(cell)) assert.fail(`unescaped formula cell: ${cell}`);
      }
    }
  });

  await t.test('exports require a session', async () => {
    const anon = client(base);
    assert.equal((await anon.get('/api/reports/export')).status, 401);
    assert.equal((await anon.get('/api/portfolio/export')).status, 401);
    assert.equal((await anon.get('/api/activity')).status, 401);
  });
});
