// Tests for server/routes/dao.js — governance proposals + fundraiser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember, loginAdmin } from './helper.js';

let srv;
let base;

before(async () => {
  srv = await bootServer();
  base = srv.base;
});

after(() => srv.stop());

// ---- auth gates ------------------------------------------------------------

test('all dao endpoints require auth (401)', async () => {
  const anon = client(base);
  assert.equal((await anon.get('/api/proposals')).status, 401);
  assert.equal((await anon.post('/api/proposals/1/vote', { support: true })).status, 401);
  assert.equal((await anon.get('/api/fundraiser')).status, 401);
  assert.equal((await anon.post('/api/fundraiser/contribute', { amount: 100 })).status, 401);
});

// ---- proposals list ---------------------------------------------------------

test('GET /api/proposals: live first then recent, real tallies start at zero', async () => {
  const { c } = await registerMember(base);
  const r = await c.get('/api/proposals');
  assert.equal(r.status, 200);
  const props = r.json.proposals;
  assert.equal(props.length, 4);
  assert.deepEqual(props.map((p) => p.code), ['OSM-042', 'OSM-041', 'OSM-040', 'OSM-039']);
  assert.deepEqual(props.map((p) => p.status), ['live', 'passed', 'passed', 'rejected']);

  const live = props[0];
  // No synthetic baseline: with no real votes the tally is honestly zero.
  assert.equal(live.forPct, 0);
  assert.equal(live.againstPct, 0);
  assert.equal(live.voters, 0);
  assert.equal(live.quorumPct, 30);
  assert.equal(live.quorumReached, false);
  assert.equal(live.yourVote, null);
  assert.ok(typeof live.endsAt === 'string' && live.endsAt.length > 0);
  assert.ok(typeof live.id === 'number');
  assert.ok(live.title.includes('Nova Reef'));
});

// ---- voting -----------------------------------------------------------------

test('POST /api/proposals/:id/vote: vote counts caller OSM power, re-vote replaces', async () => {
  const { c } = await registerMember(base); // fresh member: 10 OSM
  const liveId = (await c.get('/api/proposals')).json.proposals[0].id;

  const r1 = await c.post(`/api/proposals/${liveId}/vote`, { support: true });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.proposal.yourVote, true);
  assert.equal(r1.json.proposal.voters, 1); // this member is the first real voter
  assert.equal(r1.json.proposal.forPct, 100);

  // Re-vote flips the same vote — no extra voter row.
  const r2 = await c.post(`/api/proposals/${liveId}/vote`, { support: false });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.proposal.yourVote, false);
  assert.equal(r2.json.proposal.voters, 1);
  assert.equal(r2.json.proposal.forPct, 0);
  assert.equal(r2.json.proposal.againstPct, 100);

  // The list reflects the persisted vote too.
  const list = await c.get('/api/proposals');
  assert.equal(list.json.proposals[0].yourVote, false);
  assert.equal(list.json.proposals[0].voters, 1);
});

test('vote validation: bad support, closed proposal, missing proposal, bad id', async () => {
  const { c } = await registerMember(base);
  const props = (await c.get('/api/proposals')).json.proposals;
  const liveId = props[0].id;
  const passedId = props.find((p) => p.status === 'passed').id;

  assert.equal((await c.post(`/api/proposals/${liveId}/vote`, {})).status, 400);
  assert.equal((await c.post(`/api/proposals/${liveId}/vote`, { support: 'yes' })).status, 400);
  assert.equal((await c.post(`/api/proposals/${liveId}/vote`, { support: 1 })).status, 400);
  assert.equal((await c.post(`/api/proposals/${passedId}/vote`, { support: true })).status, 400);
  assert.equal((await c.post('/api/proposals/999999/vote', { support: true })).status, 404);
  assert.equal((await c.post('/api/proposals/abc/vote', { support: true })).status, 400);
});

test('quorum flips once enough OSM power participates (admin whale vote)', async () => {
  const { c: admin } = await loginAdmin(base); // seeded with 84300 OSM
  const liveId = (await admin.get('/api/proposals')).json.proposals[0].id;

  const r = await admin.post(`/api/proposals/${liveId}/vote`, { support: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.proposal.quorumReached, true);
  assert.ok(r.json.proposal.voters >= 2); // earlier member vote + admin
  assert.ok(r.json.proposal.forPct > 90); // whale FOR power dominates the tally
});

test('votes are private per caller: another member sees yourVote null', async () => {
  const { c } = await registerMember(base);
  const live = (await c.get('/api/proposals')).json.proposals[0];
  assert.equal(live.yourVote, null);
  assert.ok(live.voters >= 2); // other users' votes still count in aggregates
});

// ---- fundraiser detail -------------------------------------------------------

test('GET /api/fundraiser: computed pct/time-left, no fabricated panels', async () => {
  const { c } = await registerMember(base);
  const r = await c.get('/api/fundraiser');
  assert.equal(r.status, 200);
  const f = r.json.fundraiser;

  assert.equal(f.title, 'Nova Reef Series B Raise');
  assert.equal(f.target, 2400000);
  assert.equal(f.raised, 1600000);
  assert.equal(f.backers, 1204);
  assert.equal(f.pct, 66.67);
  assert.equal(f.apy, 11.1);
  assert.equal(f.minAmount, 100);
  // Seeded ends_at = boot + 9 days 6 hours; tests run within seconds of boot.
  assert.equal(f.daysLeft, 9);
  assert.ok(f.hoursLeft === 5 || f.hoursLeft === 6, `hoursLeft was ${f.hoursLeft}`);

  // No fabricated budget lines or progress announcements — empty until real
  // per-fundraiser records exist (the client hides these sections).
  assert.deepEqual(f.useOfFunds, []);
  assert.deepEqual(f.updates, []);

  assert.equal(f.ventureName, 'Nova Reef');
  assert.equal(f.proposalCode, 'OSM-042');
  assert.ok(typeof f.proposalForPct === 'number' && f.proposalForPct > 0 && f.proposalForPct < 100);
});

// ---- contribute ---------------------------------------------------------------

test('POST /api/fundraiser/contribute: debits ledger, bumps raised, backers once per user', async () => {
  const { c } = await registerMember(base); // 12450 USDC seed
  const before = (await c.get('/api/fundraiser')).json.fundraiser;

  const r1 = await c.post('/api/fundraiser/contribute', { amount: 250 });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.balance, 12200);
  assert.equal(r1.json.fundraiser.raised, before.raised + 250);
  assert.equal(r1.json.fundraiser.backers, before.backers + 1);

  // Second contribution from the same user: raised grows, backers does not.
  const r2 = await c.post('/api/fundraiser/contribute', { amount: 123.45 });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.balance, 12076.55);
  assert.equal(r2.json.fundraiser.raised, before.raised + 373.45);
  assert.equal(r2.json.fundraiser.backers, before.backers + 1);

  // Ledger agrees with the reported balance.
  const me = await c.get('/api/me');
  assert.equal(me.json.balances.USDC, 12076.55);
});

test('contribute validation: below min, non-positive, non-numeric, insufficient balance', async () => {
  const { c } = await registerMember(base);
  const before = (await c.get('/api/fundraiser')).json.fundraiser;

  assert.equal((await c.post('/api/fundraiser/contribute', { amount: 50 })).status, 400);
  assert.equal((await c.post('/api/fundraiser/contribute', { amount: 0 })).status, 400);
  assert.equal((await c.post('/api/fundraiser/contribute', { amount: -100 })).status, 400);
  assert.equal((await c.post('/api/fundraiser/contribute', { amount: 'lots' })).status, 400);
  assert.equal((await c.post('/api/fundraiser/contribute', {})).status, 400);

  const broke = await c.post('/api/fundraiser/contribute', { amount: 50000 }); // > 12450 seed
  assert.equal(broke.status, 400);
  assert.match(broke.json.error, /insufficient/i);

  // Nothing moved: balance intact, fundraiser untouched.
  assert.equal((await c.get('/api/me')).json.balances.USDC, 12450);
  const after = (await c.get('/api/fundraiser')).json.fundraiser;
  assert.equal(after.raised, before.raised);
  assert.equal(after.backers, before.backers);
});

test('contribute at exactly the minimum succeeds', async () => {
  const { c } = await registerMember(base);
  const r = await c.post('/api/fundraiser/contribute', { amount: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.json.balance, 12350);
});
