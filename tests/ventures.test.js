// Tests for server/routes/ventures.js — listing, create, invest, exit, payouts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember, loginAdmin, loginManager } from './helper.js';

// Seeded venture ids (see server/db.js): 1 Helios Grid (active, min 100),
// 3 Atlas Dry Ports (active, min 250), 5 Kite Mesh (active, min 100, no seed stakes),
// 6 Meridian Water (active, min 100, no seed stakes), 7 Terrace Farms (pending).
// Seed stakes on Helios: rosa 3100 + lena 1500 = 4600.
const HELIOS = 1;
const ATLAS = 3;
const KITE = 5;
const MERIDIAN = 6;

let srv, base, admin, manager, member;

before(async () => {
  srv = await bootServer();
  base = srv.base;
  admin = await loginAdmin(base);
  manager = await loginManager(base);
  member = await registerMember(base);
});

after(() => srv.stop());

test('401 when unauthenticated', async () => {
  const c = client(base);
  assert.equal((await c.get('/api/ventures')).status, 401);
  assert.equal((await c.post('/api/ventures', { name: 'X' })).status, 401);
  assert.equal((await c.post(`/api/ventures/${HELIOS}/invest`, { amount: 100 })).status, 401);
  assert.equal((await c.post(`/api/ventures/${HELIOS}/exit`)).status, 401);
  assert.equal((await c.post(`/api/ventures/${HELIOS}/payouts`, { kind: 'dividend', total: 10 })).status, 401);
  assert.equal((await c.get(`/api/ventures/${HELIOS}/payouts`)).status, 401);
});

test('member listing shows only active/closed, with aggregates', async () => {
  const r = await member.c.get('/api/ventures');
  assert.equal(r.status, 200);
  const { ventures } = r.json;
  assert.equal(ventures.length, 6);
  for (const v of ventures) assert.ok(['active', 'closed'].includes(v.status));

  const helios = ventures.find((v) => v.name === 'Helios Grid');
  assert.ok(helios);
  assert.equal(helios.raised, 4600);
  assert.equal(helios.filledPct, 0.23); // 4600 / 2,000,000 * 100
  assert.equal(helios.youHold, 0);
  for (const key of ['id', 'name', 'sector', 'blurb', 'apy', 'minAmount', 'targetAmount',
    'raised', 'filledPct', 'status', 'badge', 'managerId', 'payoutFreq', 'youHold']) {
    assert.ok(key in helios, `missing field ${key}`);
  }
});

test('manager and admin listings include pending ventures', async () => {
  const r = await manager.c.get('/api/ventures');
  assert.equal(r.status, 200);
  assert.equal(r.json.ventures.length, 8);
  const terrace = r.json.ventures.find((v) => v.name === 'Terrace Farms');
  assert.equal(terrace.status, 'pending');
  const atlas = r.json.ventures.find((v) => v.id === ATLAS);
  assert.equal(atlas.youHold, 1000); // marisol's seeded stake

  const ra = await admin.c.get('/api/ventures');
  assert.equal(ra.json.ventures.length, 8);
});

test('members cannot create ventures (403)', async () => {
  const r = await member.c.post('/api/ventures', {
    name: 'Nope Ltd', sector: 'AGRI', blurb: 'no', apy: 5, minAmount: 100, targetAmount: 1000,
  });
  assert.equal(r.status, 403);
});

test('manager creates a pending venture; hidden from members', async () => {
  const r = await manager.c.post('/api/ventures', {
    name: 'Cobalt Micro-Loans', sector: 'FINANCE',
    blurb: 'Micro-loans for street vendors.', apy: 6.5,
    minAmount: 50, targetAmount: 250000, payoutFreq: 'monthly',
  });
  assert.equal(r.status, 201);
  const v = r.json.venture;
  assert.equal(v.status, 'pending');
  assert.equal(v.managerId, manager.user.id);
  assert.equal(v.raised, 0);
  assert.equal(v.youHold, 0);
  assert.equal(v.payoutFreq, 'monthly');

  const memberList = await member.c.get('/api/ventures');
  assert.ok(!memberList.json.ventures.some((x) => x.id === v.id));
  const managerList = await manager.c.get('/api/ventures');
  assert.ok(managerList.json.ventures.some((x) => x.id === v.id));
});

test('venture creation validates input (400)', async () => {
  const good = { name: 'Valid Co', sector: 'AGRI', blurb: 'b', apy: 5, minAmount: 100, targetAmount: 1000 };
  assert.equal((await manager.c.post('/api/ventures', { ...good, name: undefined })).status, 400);
  assert.equal((await manager.c.post('/api/ventures', { ...good, apy: -3 })).status, 400);
  assert.equal((await manager.c.post('/api/ventures', { ...good, targetAmount: 50 })).status, 400); // < minAmount
  assert.equal((await manager.c.post('/api/ventures', { ...good, minAmount: 0 })).status, 400);
  assert.equal((await manager.c.post('/api/ventures', { ...good, payoutFreq: 'hourly' })).status, 400);
});

test('managerId assignment: admin only, must reference manager/admin', async () => {
  const byAdmin = await admin.c.post('/api/ventures', {
    name: 'Assigned Venture', sector: 'INFRA', blurb: 'b', apy: 4,
    minAmount: 100, targetAmount: 5000, managerId: manager.user.id,
  });
  assert.equal(byAdmin.status, 201);
  assert.equal(byAdmin.json.venture.managerId, manager.user.id);

  const toMember = await admin.c.post('/api/ventures', {
    name: 'Bad Assign', sector: 'INFRA', blurb: 'b', apy: 4,
    minAmount: 100, targetAmount: 5000, managerId: member.user.id,
  });
  assert.equal(toMember.status, 400);

  const byManager = await manager.c.post('/api/ventures', {
    name: 'Sneaky Assign', sector: 'INFRA', blurb: 'b', apy: 4,
    minAmount: 100, targetAmount: 5000, managerId: admin.user.id,
  });
  assert.equal(byManager.status, 403);
});

test('invest happy path debits ledger and shows in aggregates', async () => {
  const r = await member.c.post(`/api/ventures/${HELIOS}/invest`, { amount: 500 });
  assert.equal(r.status, 201);
  assert.equal(r.json.investment.ventureId, HELIOS);
  assert.equal(r.json.investment.amount, 500);
  assert.equal(r.json.investment.status, 'active');
  assert.equal(r.json.balance, 11950); // 12450 seed - 500

  const me = await member.c.get('/api/me');
  assert.equal(me.json.balances.USDC, 11950);

  const list = await member.c.get('/api/ventures');
  const helios = list.json.ventures.find((v) => v.id === HELIOS);
  assert.equal(helios.youHold, 500);
  assert.equal(helios.raised, 5100);
});

test('invest validation and guards', async () => {
  // below venture minimum (Atlas min 250)
  const low = await member.c.post(`/api/ventures/${ATLAS}/invest`, { amount: 100 });
  assert.equal(low.status, 400);
  // bad amounts
  assert.equal((await member.c.post(`/api/ventures/${HELIOS}/invest`, { amount: 0 })).status, 400);
  assert.equal((await member.c.post(`/api/ventures/${HELIOS}/invest`, { amount: -50 })).status, 400);
  assert.equal((await member.c.post(`/api/ventures/${HELIOS}/invest`, { amount: 'abc' })).status, 400);
  assert.equal((await member.c.post(`/api/ventures/${HELIOS}/invest`, {})).status, 400);
  // bad venture id
  assert.equal((await member.c.post('/api/ventures/abc/invest', { amount: 100 })).status, 400);
  assert.equal((await member.c.post('/api/ventures/99999/invest', { amount: 100 })).status, 404);
  // pending venture is not investable
  const pendingList = await manager.c.get('/api/ventures');
  const pending = pendingList.json.ventures.find((v) => v.status === 'pending');
  const pr = await member.c.post(`/api/ventures/${pending.id}/invest`, { amount: 500 });
  assert.equal(pr.status, 400);
  // insufficient balance
  const rich = await member.c.post(`/api/ventures/${HELIOS}/invest`, { amount: 999999 });
  assert.equal(rich.status, 400);
  assert.match(rich.json.error, /insufficient/i);
  // no balance change from any failed attempt
  const me = await member.c.get('/api/me');
  assert.equal(me.json.balances.USDC, 11950);
});

test('exit returns the full active stake exactly once', async () => {
  const r = await member.c.post(`/api/ventures/${HELIOS}/exit`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.returned, 500);

  const me = await member.c.get('/api/me');
  assert.equal(me.json.balances.USDC, 12450);
  const list = await member.c.get('/api/ventures');
  const helios = list.json.ventures.find((v) => v.id === HELIOS);
  assert.equal(helios.youHold, 0);
  assert.equal(helios.raised, 4600);

  // nothing left to exit
  assert.equal((await member.c.post(`/api/ventures/${HELIOS}/exit`)).status, 400);
  // never had a stake here
  assert.equal((await member.c.post(`/api/ventures/${KITE}/exit`)).status, 400);
  assert.equal((await member.c.post('/api/ventures/99999/exit')).status, 404);
});

test('payout authz: members 403, non-managing manager 403, admin ok', async () => {
  const body = { kind: 'dividend', total: 100 };
  assert.equal((await member.c.post(`/api/ventures/${HELIOS}/payouts`, body)).status, 403);

  // Venture managed by the admin — marisol (a manager, but not ITS manager) is refused.
  const created = await admin.c.post('/api/ventures', {
    name: 'Admin Managed', sector: 'INFRA', blurb: 'b', apy: 4,
    minAmount: 100, targetAmount: 5000, managerId: admin.user.id,
  });
  assert.equal(created.status, 201);
  const vid = created.json.venture.id;
  assert.equal((await manager.c.post(`/api/ventures/${vid}/payouts`, body)).status, 403);

  // Admin passes authz but there are no active investments to distribute to.
  const empty = await admin.c.post(`/api/ventures/${vid}/payouts`, body);
  assert.equal(empty.status, 400);
});

test('payout validation (400) and missing venture (404)', async () => {
  assert.equal((await manager.c.post(`/api/ventures/${HELIOS}/payouts`, { kind: 'bonus', total: 100 })).status, 400);
  assert.equal((await manager.c.post(`/api/ventures/${HELIOS}/payouts`, { kind: 'dividend', total: 0 })).status, 400);
  assert.equal((await manager.c.post(`/api/ventures/${HELIOS}/payouts`, { kind: 'dividend', total: -5 })).status, 400);
  assert.equal((await manager.c.post(`/api/ventures/${HELIOS}/payouts`, { kind: 'dividend' })).status, 400);
  assert.equal((await admin.c.post('/api/ventures/99999/payouts', { kind: 'dividend', total: 10 })).status, 404);
});

test('payouts distribute pro-rata, 2dp, remainder to largest stakeholder', async () => {
  // Kite Mesh has no seeded stakes — build a clean cap table: 500 / 300 / 200.
  const m1 = await registerMember(base);
  const m2 = await registerMember(base);
  const m3 = await registerMember(base);
  assert.equal((await m1.c.post(`/api/ventures/${KITE}/invest`, { amount: 500 })).status, 201);
  assert.equal((await m2.c.post(`/api/ventures/${KITE}/invest`, { amount: 300 })).status, 201);
  assert.equal((await m3.c.post(`/api/ventures/${KITE}/invest`, { amount: 200 })).status, 201);

  // Exact split: 250 over 1000 total stake -> 125 / 75 / 50.
  const p1 = await manager.c.post(`/api/ventures/${KITE}/payouts`, { kind: 'dividend', total: 250, memo: 'Q2 dividend' });
  assert.equal(p1.status, 201);
  assert.equal(p1.json.payout.kind, 'dividend');
  assert.equal(p1.json.payout.total, 250);
  assert.equal(p1.json.payout.memo, 'Q2 dividend');
  assert.equal(p1.json.items.length, 3);
  const share = (r, u) => r.json.items.find((i) => i.userId === u.user.id).amount;
  assert.equal(share(p1, m1), 125);
  assert.equal(share(p1, m2), 75);
  assert.equal(share(p1, m3), 50);

  // Rounding split: 100.01 -> raw 50.005 / 30.003 / 20.002 -> 50 / 30 / 20 at 2dp,
  // leaving 0.01 that must land on the largest stakeholder (m1).
  const p2 = await manager.c.post(`/api/ventures/${KITE}/payouts`, { kind: 'reimbursement', total: 100.01 });
  assert.equal(p2.status, 201);
  assert.equal(share(p2, m1), 50.01);
  assert.equal(share(p2, m2), 30);
  assert.equal(share(p2, m3), 20);
  const sum = p2.json.items.reduce((s, i) => s + i.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, 100.01);

  // Ledger credits landed: 12450 - 500 + 125 + 50.01
  const me1 = await m1.c.get('/api/me');
  assert.equal(me1.json.balances.USDC, 12125.01);
  const me2 = await m2.c.get('/api/me');
  assert.equal(me2.json.balances.USDC, 12255); // 12450 - 300 + 75 + 30

  // Payout history: newest first, per-caller yourShare.
  const h2 = await m2.c.get(`/api/ventures/${KITE}/payouts`);
  assert.equal(h2.status, 200);
  assert.equal(h2.json.payouts.length, 2);
  assert.equal(h2.json.payouts[0].kind, 'reimbursement');
  assert.equal(h2.json.payouts[0].total, 100.01);
  assert.equal(h2.json.payouts[0].yourShare, 30);
  assert.equal(h2.json.payouts[1].total, 250);
  assert.equal(h2.json.payouts[1].yourShare, 75);

  // Uninvolved caller sees the same payouts with yourShare 0.
  const hMember = await member.c.get(`/api/ventures/${KITE}/payouts`);
  assert.equal(hMember.json.payouts.length, 2);
  assert.ok(hMember.json.payouts.every((p) => p.yourShare === 0));

  // Missing venture 404s.
  assert.equal((await member.c.get('/api/ventures/99999/payouts')).status, 404);
});

test('equal stakes: remainder tie broken deterministically, funds conserved', async () => {
  // Fresh venture is impossible without admin approve (other module), so use
  // Ferrymill (id 2): seeded lena 2200. Add two equal newcomers of 100 each.
  const a = await registerMember(base);
  const b = await registerMember(base);
  assert.equal((await a.c.post('/api/ventures/2/invest', { amount: 100 })).status, 201);
  assert.equal((await b.c.post('/api/ventures/2/invest', { amount: 100 })).status, 201);

  // total stake 2400; payout 0.05 -> lena 0.045833->0.05, a 0.002083->0, b 0.
  // distributed 0.05, remainder 0 — just verify conservation & shape.
  const p = await manager.c.post('/api/ventures/2/payouts', { kind: 'dividend', total: 0.05 });
  assert.equal(p.status, 201);
  const sum = Math.round(p.json.items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  assert.equal(sum, 0.05);
  assert.equal(p.json.items.length, 3);

  // A second payout with a true remainder: 100 over 2400 stake:
  // lena 91.666->91.67, a 4.1666->4.17, b 4.17 => 100.01 distributed, remainder -0.01
  // pulled back from the largest stakeholder (lena -> 91.66). Total conserved.
  const p2 = await manager.c.post('/api/ventures/2/payouts', { kind: 'dividend', total: 100 });
  assert.equal(p2.status, 201);
  const sum2 = Math.round(p2.json.items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  assert.equal(sum2, 100);
  const aShare = p2.json.items.find((i) => i.userId === a.user.id).amount;
  const bShare = p2.json.items.find((i) => i.userId === b.user.id).amount;
  assert.equal(aShare, 4.17);
  assert.equal(bShare, 4.17);
  const lenaShare = p2.json.items.find((i) => i.userId !== a.user.id && i.userId !== b.user.id).amount;
  assert.equal(lenaShare, 91.66);
});

test('tiny payout over many equal stakes never emits a negative item or debits anyone', async () => {
  // Regression: with 7 equal 100-stakes and total 0.05, every base share
  // rounds UP to 0.01 (7 cents distributed, 2 cents overshoot). The old
  // remainder logic dumped the whole -0.02 on items[0], flipping its share
  // to -0.01 and writing a NEGATIVE 'dividend' ledger delta — a distribution
  // debiting a member. Shares must be floored at 0 and stay conserved.
  const holders = [];
  for (let i = 0; i < 7; i++) {
    const m = await registerMember(base);
    assert.equal((await m.c.post(`/api/ventures/${MERIDIAN}/invest`, { amount: 100 })).status, 201);
    holders.push(m);
  }
  const before = new Map(); // 12450 seed - 100 invested = 12350 each
  for (const h of holders) {
    before.set(h.user.id, (await h.c.get('/api/me')).json.balances.USDC);
    assert.equal(before.get(h.user.id), 12350);
  }

  const p = await manager.c.post(`/api/ventures/${MERIDIAN}/payouts`, { kind: 'dividend', total: 0.05 });
  assert.equal(p.status, 201);
  assert.equal(p.json.items.length, 7);
  for (const item of p.json.items) {
    assert.ok(item.amount >= 0, `payout item for user ${item.userId} is negative: ${item.amount}`);
  }
  const sum = Math.round(p.json.items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  assert.equal(sum, 0.05); // funds conserved

  // Repeat the pathological payout: no cumulative drain is possible either.
  for (let i = 0; i < 3; i++) {
    const rp = await manager.c.post(`/api/ventures/${MERIDIAN}/payouts`, { kind: 'dividend', total: 0.05 });
    assert.equal(rp.status, 201);
    assert.ok(rp.json.items.every((it) => it.amount >= 0));
  }

  // No negative-delta ledger row was written: every balance is >= pre-payout,
  // and every yourShare in the history is non-negative.
  for (const h of holders) {
    const bal = (await h.c.get('/api/me')).json.balances.USDC;
    assert.ok(bal >= before.get(h.user.id),
      `@${h.user.handle} was debited by a distribution: ${before.get(h.user.id)} -> ${bal}`);
    const hist = await h.c.get(`/api/ventures/${MERIDIAN}/payouts`);
    assert.equal(hist.status, 200);
    assert.equal(hist.json.payouts.length, 4);
    assert.ok(hist.json.payouts.every((x) => x.yourShare >= 0),
      `@${h.user.handle} has a negative yourShare: ${JSON.stringify(hist.json.payouts)}`);
  }
});
