// Tests for server/routes/portfolio.js — GET /api/portfolio, /api/reports,
// /api/reports/export. Empty/seeded-state tests use only auth endpoints + the
// seeded DB (marisol holds a seeded 1000 USDC stake in Atlas Dry Ports); the
// payout round-trip test additionally drives ventures.js invest/payout
// endpoints to exercise every dividend-dependent branch of this module.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember, loginManager } from './helper.js';

let srv;

before(async () => { srv = await bootServer(); });
after(() => srv.stop());

const YM_RE = /^\d{4}-\d{2}$/;
const QUARTER_ENDS = ['03-31', '06-30', '09-30', '12-31'];
const currentYm = () => new Date().toISOString().slice(0, 7);

test('401 when unauthenticated on all three endpoints', async () => {
  const c = client(srv.base);
  for (const path of ['/api/portfolio', '/api/reports', '/api/reports/export']) {
    const r = await c.get(path);
    assert.equal(r.status, 401, path);
    assert.ok(r.json.error, `${path} should return {error}`);
  }
});

test('unknown write method on portfolio path is not routed', async () => {
  const { c } = await registerMember(srv.base);
  const r = await c.post('/api/portfolio', {});
  assert.equal(r.status, 404);
});

test('fresh member portfolio is empty but fully shaped', async () => {
  const { c } = await registerMember(srv.base);
  const r = await c.get('/api/portfolio');
  assert.equal(r.status, 200);
  const p = r.json;

  assert.equal(p.deployed, 0);
  assert.equal(p.currentValue, 0);
  assert.equal(p.netPl, 0);
  assert.equal(p.netPlPct, 0);
  assert.equal(p.nextDividend, null);
  assert.deepEqual(p.positions, []);
  assert.deepEqual(p.allocation, []);
  assert.deepEqual(p.diversification, { score: 0, sectors: 0 });

  // 12 months of series, oldest first, ending with the current month, all
  // zero: the seed credit is cash, not deployed value (and OSM is excluded).
  assert.equal(p.series.length, 12);
  for (const s of p.series) {
    assert.match(s.month, YM_RE);
    assert.equal(s.value, 0);
  }
  assert.equal(p.series[11].month, currentYm());
  const sorted = [...p.series].sort((a, b) => a.month.localeCompare(b.month));
  assert.deepEqual(p.series, sorted);
});

test('manager portfolio reflects the seeded Atlas stake', async () => {
  const { c } = await loginManager(srv.base);
  const r = await c.get('/api/portfolio');
  assert.equal(r.status, 200);
  const p = r.json;

  assert.equal(p.deployed, 1000);
  assert.equal(p.currentValue, 1000); // no dividends paid yet
  assert.equal(p.netPl, 0);
  assert.equal(p.netPlPct, 0);

  assert.equal(p.positions.length, 1);
  const pos = p.positions[0];
  assert.equal(typeof pos.ventureId, 'number');
  assert.equal(pos.name, 'Atlas Dry Ports');
  assert.equal(pos.sector, 'LOGISTICS');
  assert.equal(pos.stake, 1000);
  assert.equal(pos.valueNow, 1000);
  assert.equal(pos.pl, 0);
  assert.equal(pos.plPct, 0);
  assert.equal(pos.apy, 7.8);
  assert.equal(pos.dividendsPaid, 0);

  assert.deepEqual(p.allocation, [{ name: 'Atlas Dry Ports', pct: 100 }]);
  assert.deepEqual(p.diversification, { score: 0, sectors: 1 }); // single sector

  // Series ends at deployed value this month (invest ledger row replayed).
  assert.equal(p.series.length, 12);
  assert.equal(p.series[11].month, currentYm());
  assert.equal(p.series[11].value, 1000);
  assert.equal(p.series[0].value, 0);

  // Next dividend: quarter of APY on the seeded stake, due next quarter end.
  assert.ok(p.nextDividend);
  assert.equal(p.nextDividend.venture, 'Atlas Dry Ports');
  assert.equal(p.nextDividend.amount, 19.5); // 1000 * 7.8% / 4
  assert.ok(QUARTER_ENDS.includes(p.nextDividend.date.slice(5)), p.nextDividend.date);
  assert.ok(p.nextDividend.date >= new Date().toISOString().slice(0, 10));
});

test('portfolio is scoped to the caller (no cross-user leakage)', async () => {
  const { c } = await registerMember(srv.base);
  const r = await c.get('/api/portfolio');
  assert.equal(r.status, 200);
  // Marisol's seeded Atlas position must never appear for another member.
  assert.deepEqual(r.json.positions, []);
  assert.equal(r.json.deployed, 0);
});

test('reports for a fresh member: seed-only YTD aggregates', async () => {
  const { c } = await registerMember(srv.base);
  const r = await c.get('/api/reports');
  assert.equal(r.status, 200);
  const rep = r.json;

  assert.equal(rep.netWorthYtd, 12450); // USDC seed; OSM excluded
  assert.equal(rep.netWorthYtdPct, 100); // no prior-year baseline
  assert.equal(rep.dividendsYtd, 0);
  assert.equal(rep.feesYtd, 0);
  assert.equal(rep.receiptsFiled, 0);
  assert.deepEqual(rep.dividendLedger, []);

  // Statements: ledger grouped by month → one month, 2 rows (USDC + OSM seed).
  assert.equal(rep.statements.length, 1);
  assert.equal(rep.statements[0].month, currentYm());
  assert.equal(rep.statements[0].txCount, 2);
  assert.ok(rep.statements[0].sizeMb > 0);
});

test('reports for the manager exclude invest debits from net worth', async () => {
  const { c } = await loginManager(srv.base);
  const r = await c.get('/api/reports');
  assert.equal(r.status, 200);
  const rep = r.json;

  // Seed +12450, invest -1000 → invest is net-worth-neutral (cash -> stake).
  assert.equal(rep.netWorthYtd, 12450);
  assert.equal(rep.dividendsYtd, 0);
  assert.equal(rep.statements.length, 1);
  assert.equal(rep.statements[0].txCount, 3); // USDC seed, OSM seed, invest
});

test('CSV export returns only the caller ledger as text/csv', async () => {
  const { c: member } = await registerMember(srv.base);
  const { c: manager } = await loginManager(srv.base);

  const fetchCsv = async (cli) => {
    const res = await fetch(`${srv.base}/api/reports/export`, {
      headers: { Cookie: cli.cookieValue() },
    });
    return { res, text: await res.text() };
  };

  const m = await fetchCsv(member);
  assert.equal(m.res.status, 200);
  assert.ok(m.res.headers.get('content-type').startsWith('text/csv'));
  assert.ok(m.res.headers.get('content-disposition').includes('.csv'));
  const memberLines = m.text.trim().split(/\r?\n/);
  assert.equal(memberLines[0], 'id,date,currency,kind,amount,refType,refId,memo');
  assert.equal(memberLines.length, 3); // header + USDC seed + OSM seed
  assert.ok(m.text.includes('seed'));
  assert.ok(!m.text.includes('invest'), 'must not leak other users rows');

  const g = await fetchCsv(manager);
  assert.equal(g.res.status, 200);
  const managerLines = g.text.trim().split(/\r?\n/);
  assert.equal(managerLines.length, 4); // header + 2 seeds + 1 invest
  assert.ok(g.text.includes('invest'));
  assert.ok(g.text.includes('-1000'));
});
