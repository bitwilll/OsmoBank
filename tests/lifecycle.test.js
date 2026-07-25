// Tests for the operator consoles added alongside the venture lifecycle:
// venture phases + admin edit, Osmo Assure KYC, proposals and risk signals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember, loginAdmin, loginManager } from './helper.js';

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

let srv, base, admin, manager, member;

before(async () => {
  srv = await bootServer();
  base = srv.base;
  admin = await loginAdmin(base);
  manager = await loginManager(base);
  member = await registerMember(base);
});

after(() => srv.stop());

// ---- venture lifecycle -------------------------------------------------------

test('phase is derived from real dates: upcoming → live → closed', async () => {
  const mk = async (opensAt, closesAt) => {
    const r = await admin.c.post('/api/ventures', {
      name: `Phase ${opensAt}-${closesAt}`, sector: 'INFRA', blurb: 'b',
      apy: 5, minAmount: 100, targetAmount: 10000, opensAt, closesAt,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    await admin.c.post(`/api/admin/ventures/${r.json.venture.id}/approve`);
    return r.json.venture.id;
  };

  const upcomingId = await mk(day(10), day(40));
  const liveId = await mk(day(-5), day(30));
  const closedId = await mk(day(-40), day(-10));

  const list = (await admin.c.get('/api/ventures')).json.ventures;
  const by = (id) => list.find((v) => v.id === id);

  assert.equal(by(upcomingId).phase, 'upcoming');
  assert.equal(by(upcomingId).investable, false);
  assert.equal(by(upcomingId).daysUntilOpen, 10);

  assert.equal(by(liveId).phase, 'live');
  assert.equal(by(liveId).investable, true);
  assert.equal(by(liveId).daysUntilOpen, null);

  assert.equal(by(closedId).phase, 'closed');
  assert.equal(by(closedId).investable, false);

  // Upcoming ventures are public — the pipeline is visible to visitors.
  const anon = (await client(base).get('/api/ventures')).json.ventures;
  assert.ok(anon.some((v) => v.id === upcomingId && v.phase === 'upcoming'));
});

test('an upcoming venture cannot be invested in yet', async () => {
  const r = await admin.c.post('/api/ventures', {
    name: 'Not Open Yet', sector: 'AGRI', blurb: 'b', apy: 4,
    minAmount: 100, targetAmount: 5000, opensAt: day(14),
  });
  await admin.c.post(`/api/admin/ventures/${r.json.venture.id}/approve`);
  const invest = await member.c.post(`/api/ventures/${r.json.venture.id}/invest`, { amount: 500 });
  assert.equal(invest.status, 400);
  assert.match(invest.json.error, /opens on/i);
});

test('venture dates are validated: real dates, closing on or after opening', async () => {
  const good = { name: 'Date Check', sector: 'INFRA', blurb: 'b', apy: 4, minAmount: 100, targetAmount: 5000 };
  assert.equal((await admin.c.post('/api/ventures', { ...good, opensAt: '2026-13-45' })).status, 400);
  assert.equal((await admin.c.post('/api/ventures', { ...good, opensAt: 'soon' })).status, 400);
  assert.equal((await admin.c.post('/api/ventures',
    { ...good, opensAt: day(30), closesAt: day(10) })).status, 400);
});

test('admin ventures list covers every status and counts holders', async () => {
  const all = await admin.c.get('/api/admin/ventures');
  assert.equal(all.status, 200);
  const statuses = new Set(all.json.ventures.map((v) => v.status));
  assert.ok(statuses.has('pending'), 'pending ventures are only visible here');
  const helios = all.json.ventures.find((v) => v.id === 1);
  assert.ok(helios.holders >= 2, `expected seeded holders, got ${helios.holders}`);
  assert.ok(helios.createdAt);

  // Members never reach the console.
  assert.equal((await member.c.get('/api/admin/ventures')).status, 403);
});

test('a venture listed from the console still needs approval', async () => {
  // Exactly the payload the console form posts, blank dates included.
  const created = await admin.c.post('/api/ventures', {
    name: 'Console Listed Co', sector: 'ENERGY', blurb: 'Listed from the operator console.',
    apy: 9, minAmount: 100, targetAmount: 50000, opensAt: null, closesAt: null,
  });
  assert.equal(created.status, 201);
  const v = created.json.venture;
  assert.equal(v.status, 'pending', 'creating from the console is not a self-approval');
  assert.equal(v.phase, 'pending');
  assert.equal(v.investable, false);
  assert.equal(v.opensAt, null);

  // Members cannot see it on the floor, and staking is refused while it is pending.
  assert.equal((await member.c.get('/api/ventures')).json.ventures.some((x) => x.id === v.id), false);
  const early = await member.c.post(`/api/ventures/${v.id}/invest`, { amount: 500 });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /not open for investment/i);

  assert.equal((await admin.c.post(`/api/admin/ventures/${v.id}/approve`, {})).status, 200);
  const live = (await member.c.get('/api/ventures')).json.ventures.find((x) => x.id === v.id);
  assert.equal(live.phase, 'live');
  assert.equal(live.investable, true);
});

test('admin edit is partial, validates the merged shape, and is audited', async () => {
  const created = await admin.c.post('/api/ventures', {
    name: 'Editable Co', sector: 'INFRA', blurb: 'b', apy: 4, minAmount: 500, targetAmount: 20000,
  });
  const id = created.json.venture.id;

  // A partial edit leaves untouched fields alone.
  const edit = await admin.c.patch(`/api/admin/ventures/${id}`, { apy: 6.5, badge: 'NEW' });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.venture.apy, 6.5);
  assert.equal(edit.json.venture.badge, 'NEW');
  assert.equal(edit.json.venture.minAmount, 500, 'untouched field survived');

  // The merged shape is what gets validated: target alone would drop below the
  // stored minimum.
  assert.equal((await admin.c.patch(`/api/admin/ventures/${id}`, { targetAmount: 100 })).status, 400);
  assert.equal((await admin.c.patch(`/api/admin/ventures/${id}`, {})).status, 400);
  assert.equal((await admin.c.patch('/api/admin/ventures/99999', { apy: 3 })).status, 404);

  // Badge clears back to nothing.
  assert.equal((await admin.c.patch(`/api/admin/ventures/${id}`, { badge: null })).json.venture.badge, null);

  const log = await admin.c.get('/api/admin/audit');
  assert.ok(log.json.entries.some((e) => e.action === 'venture.update'));
});

test('closing a venture with live stakes needs force', async () => {
  const created = await admin.c.post('/api/ventures', {
    name: 'Has Stakes Co', sector: 'AGRI', blurb: 'b', apy: 4, minAmount: 100, targetAmount: 9000,
  });
  const id = created.json.venture.id;
  await admin.c.post(`/api/admin/ventures/${id}/approve`);
  assert.equal((await member.c.post(`/api/ventures/${id}/invest`, { amount: 300 })).status, 201);

  const blocked = await admin.c.patch(`/api/admin/ventures/${id}`, { status: 'closed' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /still active/i);

  const forced = await admin.c.patch(`/api/admin/ventures/${id}`, { status: 'closed', force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.venture.phase, 'closed');
});

// ---- Osmo Assure -------------------------------------------------------------

const KYC_BODY = {
  fullName: 'Ada Lovelace King',
  dateOfBirth: '1990-04-12',
  country: 'gb',
  docType: 'passport',
  docNumber: 'X1234567',
  address: '12 Analytical Way, London',
  consent: true,
};

test('KYC: identifying details are sealed, never returned to the member', async () => {
  const m = await registerMember(base);
  const empty = await m.c.get('/api/kyc');
  assert.equal(empty.status, 200);
  assert.equal(empty.json.submission, null);
  assert.equal(empty.json.verified, false);
  assert.equal(empty.json.canSubmit, true);
  assert.equal(empty.json.protection.algorithm, 'AES-256-GCM');

  const sent = await m.c.post('/api/kyc', KYC_BODY);
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.equal(sent.json.submission.status, 'pending');
  assert.equal(sent.json.submission.country, 'GB');

  // Nothing identifying comes back on any member-facing payload.
  const mine = await m.c.get('/api/kyc');
  const asText = JSON.stringify(mine.json);
  for (const secret of ['Ada Lovelace', '1990-04-12', 'X1234567', 'Analytical Way']) {
    assert.equal(asText.includes(secret), false, `member payload leaked ${secret}`);
  }
  assert.equal(mine.json.canSubmit, false);
});

test('KYC: consent is required and the payload is validated', async () => {
  const m = await registerMember(base);
  assert.equal((await m.c.post('/api/kyc', { ...KYC_BODY, consent: false })).status, 400);
  assert.equal((await m.c.post('/api/kyc', { ...KYC_BODY, docType: 'library_card' })).status, 400);
  assert.equal((await m.c.post('/api/kyc', { ...KYC_BODY, country: 'GBR' })).status, 400);
  assert.equal((await m.c.post('/api/kyc', { ...KYC_BODY, dateOfBirth: '2025-01-01' })).status, 400); // under 16
  assert.equal((await m.c.post('/api/kyc', { ...KYC_BODY, dateOfBirth: day(30) })).status, 400); // future
  assert.equal((await m.c.post('/api/kyc', { ...KYC_BODY, dateOfBirth: 'yesterday' })).status, 400);
  assert.equal((await client(base).post('/api/kyc', KYC_BODY)).status, 401);
});

test('KYC: the reviewer queue carries no identity until a record is opened', async () => {
  const m = await registerMember(base);
  await m.c.post('/api/kyc', KYC_BODY);

  const queue = await admin.c.get('/api/admin/kyc');
  assert.equal(queue.status, 200);
  const row = queue.json.submissions.find((s) => s.userId === m.user.id);
  assert.ok(row, 'submission reached the queue');
  assert.equal(row.initials, 'ALK');
  assert.equal(row.country, 'GB');
  // Listing the queue must not decrypt anything.
  const listText = JSON.stringify(queue.json);
  for (const secret of ['Ada Lovelace', '1990-04-12', 'X1234567']) {
    assert.equal(listText.includes(secret), false, `queue leaked ${secret}`);
  }

  // Opening one is the only decrypting path — and it is audited.
  const opened = await admin.c.get(`/api/admin/kyc/${row.id}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.json.details.fullName, 'Ada Lovelace King');
  assert.equal(opened.json.details.docNumber, 'X1234567');
  assert.equal(opened.json.details.docNumberMasked, '••••4567');

  const log = await admin.c.get('/api/admin/audit');
  assert.ok(log.json.entries.some((e) => e.action === 'kyc.open' && e.subject === `kyc:${row.id}`));

  // Members cannot reach the reviewer console at all.
  assert.equal((await m.c.get('/api/admin/kyc')).status, 403);
  assert.equal((await m.c.get(`/api/admin/kyc/${row.id}`)).status, 403);
});

test('KYC: what is written to the database is ciphertext', async () => {
  const m = await registerMember(base);
  await m.c.post('/api/kyc', KYC_BODY);
  const { createClient } = await import('@libsql/client/node');
  const raw = createClient({ url: `file:${srv.dbPath}` });
  const rows = (await raw.execute('SELECT sealed FROM kyc_submissions')).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) {
    if (!r.sealed) continue; // withdrawn records are erased
    assert.match(String(r.sealed), /^v1\./);
    for (const secret of ['Ada', '1990-04-12', 'X1234567']) {
      assert.equal(String(r.sealed).includes(secret), false, 'plaintext hit the database');
    }
  }
  raw.close();
});

test('KYC: approving verifies the account; rejecting must say why', async () => {
  const approved = await registerMember(base);
  await approved.c.post('/api/kyc', KYC_BODY);
  const queue = await admin.c.get('/api/admin/kyc');
  const id = queue.json.submissions.find((s) => s.userId === approved.user.id).id;

  assert.equal((await admin.c.patch(`/api/admin/kyc/${id}`, { status: 'maybe' })).status, 400);
  const ok = await admin.c.patch(`/api/admin/kyc/${id}`, { status: 'approved' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.submission.status, 'approved');
  assert.equal((await approved.c.get('/api/kyc')).json.verified, true);
  // A decided submission cannot be decided twice.
  assert.equal((await admin.c.patch(`/api/admin/kyc/${id}`, { status: 'rejected', note: 'x' })).status, 400);

  const rejected = await registerMember(base);
  await rejected.c.post('/api/kyc', KYC_BODY);
  const rid = (await admin.c.get('/api/admin/kyc')).json.submissions
    .find((s) => s.userId === rejected.user.id).id;
  assert.equal((await admin.c.patch(`/api/admin/kyc/${rid}`, { status: 'rejected' })).status, 400);
  const no = await admin.c.patch(`/api/admin/kyc/${rid}`, { status: 'rejected', note: 'Document was unreadable' });
  assert.equal(no.status, 200);
  const after = await rejected.c.get('/api/kyc');
  assert.equal(after.json.submission.decisionNote, 'Document was unreadable');
  assert.equal(after.json.canSubmit, true, 'a rejected member may correct and resubmit');
  assert.equal((await rejected.c.post('/api/kyc', KYC_BODY)).status, 201);
});

test('KYC: the overview agrees with the queue and the member list', async () => {
  const before = (await admin.c.get('/api/admin/overview')).json;
  const m = await registerMember(base);
  // A brand-new account has submitted nothing — that is 'none', never a tick.
  const listed = (await admin.c.get('/api/admin/overview')).json
    .newestMembers.find((u) => u.id === m.user.id);
  assert.equal(listed.kyc, 'none');
  assert.equal(listed.status, 'active');

  await m.c.post('/api/kyc', KYC_BODY);
  const mid = (await admin.c.get('/api/admin/overview')).json;
  assert.equal(mid.needsAction.kyc, before.needsAction.kyc + 1);
  assert.equal(mid.newestMembers.find((u) => u.id === m.user.id).kyc, 'pending');

  const id = (await admin.c.get('/api/admin/kyc')).json.submissions
    .find((s) => s.userId === m.user.id).id;
  await admin.c.patch(`/api/admin/kyc/${id}`, { status: 'approved' });
  const after = (await admin.c.get('/api/admin/overview')).json;
  assert.equal(after.needsAction.kyc, before.needsAction.kyc);
  assert.equal(after.newestMembers.find((u) => u.id === m.user.id).kyc, 'verified');
});

test('KYC: withdrawing erases the sealed record and blocks a stranger', async () => {
  const m = await registerMember(base);
  const sent = await m.c.post('/api/kyc', KYC_BODY);
  const id = sent.json.submission.id;

  const stranger = await registerMember(base);
  assert.equal((await stranger.c.del(`/api/kyc/${id}`)).status, 403);

  const gone = await m.c.del(`/api/kyc/${id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.submission.status, 'withdrawn');
  // The details are destroyed — even a reviewer gets nothing back.
  assert.equal((await admin.c.get(`/api/admin/kyc/${id}`)).status, 410);
  assert.equal((await m.c.del(`/api/kyc/${id}`)).status, 400);
  assert.equal((await m.c.get('/api/kyc')).json.canSubmit, true);
});

// ---- governance --------------------------------------------------------------

test('proposals: created live, auto-numbered, and visible to members', async () => {
  const created = await admin.c.post('/api/admin/proposals', {
    title: 'Adopt the quarterly reserve policy', blurb: 'Set aside 5% each quarter.', days: 14,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.proposal.code, /^OSM-\d{3}$/);
  assert.equal(created.json.proposal.status, 'live');

  const gov = await member.c.get('/api/proposals');
  const mine = gov.json.proposals.find((p) => p.code === created.json.proposal.code);
  assert.ok(mine, 'the new proposal reached the governance screen');
  // Tallies start from real votes only — nothing manufactured.
  assert.equal(mine.voters, 0);
  assert.equal(mine.forPct, 0);
  assert.equal(mine.againstPct, 0);
  assert.equal(mine.yourVote, null);
  assert.equal(mine.quorumReached, false);

  // …and a real vote is what moves them.
  assert.equal((await member.c.post(`/api/proposals/${created.json.proposal.id}/vote`, { support: true })).status, 200);
  const voted = (await member.c.get('/api/proposals')).json.proposals
    .find((p) => p.id === created.json.proposal.id);
  assert.equal(voted.voters, 1);
  assert.equal(voted.forPct, 100);
  assert.equal(voted.yourVote, true);

  // A second one auto-numbers upward and duplicate codes are refused.
  const next = await admin.c.post('/api/admin/proposals', { title: 'Second motion for the floor' });
  assert.notEqual(next.json.proposal.code, created.json.proposal.code);
  assert.equal((await admin.c.post('/api/admin/proposals',
    { title: 'Clashing motion here', code: created.json.proposal.code })).status, 409);

  assert.equal((await admin.c.post('/api/admin/proposals', { title: 'no' })).status, 400);
  assert.equal((await member.c.post('/api/admin/proposals', { title: 'Members may not open votes' })).status, 403);
});

test('proposals: an operator can edit and record the outcome', async () => {
  const created = await admin.c.post('/api/admin/proposals', { title: 'Motion to be amended later' });
  const id = created.json.proposal.id;

  const edited = await admin.c.patch(`/api/admin/proposals/${id}`,
    { title: 'Motion, as amended on the floor', quorumPct: 45, days: 3 });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.proposal.title, 'Motion, as amended on the floor');
  assert.equal(edited.json.proposal.quorum_pct, 45);

  const passed = await admin.c.patch(`/api/admin/proposals/${id}`, { status: 'passed' });
  assert.equal(passed.json.proposal.status, 'passed');

  assert.equal((await admin.c.patch(`/api/admin/proposals/${id}`, { status: 'sideways' })).status, 400);
  assert.equal((await admin.c.patch(`/api/admin/proposals/${id}`, {})).status, 400);
  assert.equal((await admin.c.patch('/api/admin/proposals/99999', { status: 'passed' })).status, 404);
  assert.equal((await member.c.patch(`/api/admin/proposals/${id}`, { status: 'passed' })).status, 403);

  const log = await admin.c.get('/api/admin/audit');
  assert.ok(log.json.entries.some((e) => e.action === 'proposal.update'));
});

// ---- risk --------------------------------------------------------------------

test('risk signals are computed from real rows', async () => {
  const before = await admin.c.get('/api/admin/risk');
  assert.equal(before.status, 200);
  assert.equal((await member.c.get('/api/admin/risk')).status, 403);

  const sig = (payload, key) => payload.json.signals.find((s) => s.key === key);
  assert.ok(sig(before, 'kyc_backlog'), 'every signal is present even at zero');
  assert.ok(before.json.checkedAt);
  // Signals are ranked, worst first.
  const rank = { high: 3, medium: 2, low: 1, ok: 0 };
  const ranks = before.json.signals.map((s) => rank[s.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));

  // A fresh KYC submission moves a real counter.
  const backlogBefore = sig(before, 'kyc_backlog').count;
  const m = await registerMember(base);
  await m.c.post('/api/kyc', KYC_BODY);
  const after = await admin.c.get('/api/admin/risk');
  assert.equal(sig(after, 'kyc_backlog').count, backlogBefore + 1);
  assert.notEqual(sig(after, 'kyc_backlog').severity, 'ok');
  assert.ok(after.json.needsAction >= 1);

  // And a venture closing next week is picked up by its date, not a flag.
  const closingBefore = sig(after, 'closing_soon').count;
  const v = await admin.c.post('/api/ventures', {
    name: 'Closing Soon Co', sector: 'INFRA', blurb: 'b', apy: 4,
    minAmount: 100, targetAmount: 5000, closesAt: day(3),
  });
  await admin.c.post(`/api/admin/ventures/${v.json.venture.id}/approve`);
  const later = await admin.c.get('/api/admin/risk');
  assert.equal(sig(later, 'closing_soon').count, closingBefore + 1);
});
