// Admin module tests — boots one real server for the whole file.
// Tests run in declaration order; read-only assertions (overview, search)
// run before the mutating ones so seeded counts stay deterministic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, registerMember, loginAdmin, loginManager } from './helper.js';

let srv, admin, manager, member;

before(async () => {
  srv = await bootServer();
  admin = await loginAdmin(srv.base);
  manager = await loginManager(srv.base);
  member = await registerMember(srv.base);
});

after(() => srv?.stop());

test('401 for every admin endpoint without a session', async () => {
  const anon = client(srv.base);
  for (const [method, path] of [
    ['get', '/api/admin/overview'],
    ['get', '/api/admin/users'],
    ['patch', '/api/admin/users/2'],
    ['post', '/api/admin/ventures/1/approve'],
    ['post', '/api/admin/ventures/1/reject'],
    ['get', '/api/admin/audit'],
  ]) {
    const r = method === 'get' ? await anon.get(path)
      : method === 'patch' ? await anon.patch(path, { role: 'manager' })
        : await anon.post(path, {});
    assert.equal(r.status, 401, `${method.toUpperCase()} ${path}`);
  }
});

test('403 for wrong roles (member everywhere, manager on admin-only routes)', async () => {
  assert.equal((await member.c.get('/api/admin/overview')).status, 403);
  assert.equal((await member.c.get('/api/admin/users')).status, 403);
  assert.equal((await member.c.get('/api/admin/audit')).status, 403);
  assert.equal((await member.c.patch(`/api/admin/users/${member.user.id}`, { role: 'admin' })).status, 403);

  assert.equal((await manager.c.get('/api/admin/overview')).status, 403);
  assert.equal((await manager.c.get('/api/admin/users')).status, 403);
  assert.equal((await manager.c.patch(`/api/admin/users/${member.user.id}`, { role: 'manager' })).status, 403);
  assert.equal((await manager.c.post('/api/admin/ventures/1/approve', {})).status, 403);
  assert.equal((await manager.c.post('/api/admin/ventures/1/reject', {})).status, 403);
});

test('overview: real counts, treasury, queues, newest members, network', async () => {
  const r = await admin.c.get('/api/admin/overview');
  assert.equal(r.status, 200);
  const o = r.json;

  // 5 seeded users + 1 registered member, all created within the week.
  assert.equal(o.members, 6);
  assert.equal(o.membersThisWeek, 6);

  // Treasury = SUM of all USDC ledger: 6 × 12450 seed − 8700 seeded stakes.
  assert.equal(o.treasury, 66000);
  // 24h volume = abs USDC movement: 74700 credits + 8700 invest debits.
  assert.equal(o.volume24h, 83400);
  assert.equal(o.transfers24h, 0);

  assert.deepEqual(o.needsAction, { listings: 2, payoutsDue: 4, kyc: 1 });

  // Listing queue = the two seeded pending ventures.
  assert.equal(o.listingQueue.length, 2);
  const names = o.listingQueue.map((v) => v.name);
  assert.ok(names.includes('Terrace Farms'));
  assert.ok(names.includes('Kite Mesh — Metro 4'));
  for (const v of o.listingQueue) {
    assert.equal(v.status, 'pending');
    assert.equal(typeof v.ventureId, 'number');
    assert.equal(typeof v.blurb, 'string');
  }

  // Payout queue = the 4 active ventures holding stakes; est = raised*apy%/4.
  assert.equal(o.payoutQueue.length, 4);
  const helios = o.payoutQueue.find((v) => v.name === 'Helios Grid');
  assert.ok(helios, 'Helios Grid should be in the payout queue');
  assert.equal(helios.estTotal, 142.6); // (3100+1500) × 12.4% / 4
  assert.equal(helios.holders, 2);
  for (const v of o.payoutQueue) {
    assert.match(v.due, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(v.estTotal > 0);
    assert.ok(v.holders >= 1);
  }
  // Due date is the end of the current quarter (never in the past).
  assert.ok(new Date(o.payoutQueue[0].due + 'T23:59:59Z') >= new Date());

  // Newest members, newest first, with synthetic member numbers.
  assert.equal(o.newestMembers.length, 5);
  assert.equal(o.newestMembers[0].id, member.user.id);
  for (const m of o.newestMembers) {
    assert.equal(m.memberNo, 48195 + m.id);
    assert.equal(typeof m.joinedAgo, 'string');
    assert.ok(['verified', 'pending'].includes(m.kyc));
    assert.ok(['active', 'review', 'frozen'].includes(m.status));
  }
  const tunde = o.newestMembers.find((m) => m.handle === 'tunde');
  assert.equal(tunde.kyc, 'pending'); // status 'review' → KYC pending
  assert.equal(o.newestMembers[0].joinedAgo, 'just now');

  // Deterministic synthetic network stats.
  assert.ok(Number.isInteger(o.network.block) && o.network.block > 1842000);
  assert.equal(typeof o.network.latencyMs, 'number');
  assert.ok(o.network.uptimePct > 99 && o.network.uptimePct <= 100);
  assert.equal(o.network.signers, 2); // admin + marisol

  // Deterministic: a second call returns identical network stats.
  const r2 = await admin.c.get('/api/admin/overview');
  assert.deepEqual(r2.json.network, o.network);
});

test('user search: full list, q filter, balances, no secrets', async () => {
  const all = await admin.c.get('/api/admin/users');
  assert.equal(all.status, 200);
  assert.equal(all.json.users.length, 6);
  for (const u of all.json.users) {
    assert.equal(typeof u.balance, 'number');
    assert.ok(!('pass' in u), 'must not leak password hashes');
  }

  const rosa = await admin.c.get('/api/admin/users?q=rosa');
  assert.equal(rosa.status, 200);
  assert.equal(rosa.json.users.length, 1);
  assert.equal(rosa.json.users[0].handle, 'rosa');
  assert.equal(rosa.json.users[0].balance, 8450); // 12450 − 3100 − 900 invested

  // Matches name and email too; leading @ is tolerated.
  const byName = await admin.c.get('/api/admin/users?q=Delgado');
  assert.equal(byName.json.users.length, 1);
  const byEmail = await admin.c.get('/api/admin/users?q=osmo.money');
  assert.equal(byEmail.json.users.length, 5);
  const atHandle = await admin.c.get('/api/admin/users?q=%40rosa');
  assert.equal(atHandle.json.users.length, 1);

  // LIKE wildcards are escaped, not interpreted.
  const wild = await admin.c.get('/api/admin/users?q=%25%25');
  assert.equal(wild.status, 200);
  assert.equal(wild.json.users.length, 0);
});

test('role/status assignment: happy path, validation, self/last-admin guards', async () => {
  // Promote the member to manager, put them in review, then restore.
  let r = await admin.c.patch(`/api/admin/users/${member.user.id}`, { role: 'manager' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'manager');

  r = await admin.c.patch(`/api/admin/users/${member.user.id}`, { status: 'review' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.status, 'review');

  r = await admin.c.patch(`/api/admin/users/${member.user.id}`, { role: 'member', status: 'active' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'member');
  assert.equal(r.json.user.status, 'active');

  // Validation failures.
  assert.equal((await admin.c.patch(`/api/admin/users/${member.user.id}`, { role: 'superadmin' })).status, 400);
  assert.equal((await admin.c.patch(`/api/admin/users/${member.user.id}`, { status: 'banned' })).status, 400);
  assert.equal((await admin.c.patch(`/api/admin/users/${member.user.id}`, {})).status, 400);
  assert.equal((await admin.c.patch('/api/admin/users/abc', { role: 'manager' })).status, 400);
  assert.equal((await admin.c.patch('/api/admin/users/99999', { role: 'manager' })).status, 404);

  // Sole admin cannot be demoted (self-demotion hits the last-admin guard).
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { role: 'member' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /last admin/i);

  // With a second admin present, changing your own role is still refused...
  const second = await registerMember(srv.base);
  r = await admin.c.patch(`/api/admin/users/${second.user.id}`, { role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'admin');
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { role: 'member' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /own role/i);

  // ...but demoting a non-last admin works.
  r = await admin.c.patch(`/api/admin/users/${second.user.id}`, { role: 'member' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'member');

  // Freezing kills the target's sessions immediately.
  r = await admin.c.patch(`/api/admin/users/${second.user.id}`, { status: 'frozen' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.status, 'frozen');
  assert.equal((await second.c.get('/api/me')).status, 401);
});

test('last-admin freeze guard: the last usable admin can never be locked out', async () => {
  // The sole admin cannot freeze themselves — that would revoke their sessions,
  // refuse their next login, and leave nobody able to unfreeze them.
  let r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { status: 'frozen' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /last admin/i);
  // The admin session survives and the admin surface still works.
  assert.equal((await admin.c.get('/api/me')).status, 200);
  assert.equal((await admin.c.get('/api/admin/overview')).status, 200);

  // Combined role+status writes cannot sneak past the guard either.
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { role: 'member', status: 'frozen' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /last admin/i);

  // With a second ACTIVE admin present, freezing one of them is allowed.
  const extra = await registerMember(srv.base);
  r = await admin.c.patch(`/api/admin/users/${extra.user.id}`, { role: 'admin' });
  assert.equal(r.status, 200);
  r = await admin.c.patch(`/api/admin/users/${extra.user.id}`, { status: 'frozen' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.status, 'frozen');
  assert.equal((await extra.c.get('/api/me')).status, 401); // sessions revoked

  // A frozen admin is NOT usable, so it must not satisfy the invariant:
  // the remaining active admin still cannot be frozen or demoted.
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { status: 'frozen' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /last admin/i);
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { role: 'member' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /last admin/i);

  // Demoting the frozen admin is fine — it does not reduce usable admins.
  r = await admin.c.patch(`/api/admin/users/${extra.user.id}`, { role: 'member' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'member');
  r = await admin.c.patch(`/api/admin/users/${extra.user.id}`, { status: 'active' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.status, 'active');

  // 'review' does not block login or sessions, so it is not guarded — the
  // sole admin may enter review and can still restore themselves.
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { status: 'review' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.status, 'review');
  // ...but a review admin still cannot self-freeze into a lockout.
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { status: 'frozen' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /last admin/i);
  r = await admin.c.patch(`/api/admin/users/${admin.user.id}`, { status: 'active' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.status, 'active');
});

test('venture approve/reject with manager assignment and state guards', async () => {
  const o = (await admin.c.get('/api/admin/overview')).json;
  const p1 = o.listingQueue.find((v) => v.name === 'Terrace Farms').ventureId;
  const p2 = o.listingQueue.find((v) => v.name === 'Kite Mesh — Metro 4').ventureId;

  // managerId must reference a manager or admin.
  assert.equal((await admin.c.post(`/api/admin/ventures/${p1}/approve`, { managerId: member.user.id })).status, 400);
  assert.equal((await admin.c.post(`/api/admin/ventures/${p1}/approve`, { managerId: 99999 })).status, 400);
  assert.equal((await admin.c.post(`/api/admin/ventures/${p1}/approve`, { managerId: 'x' })).status, 400);

  // Approve with an explicit manager.
  let r = await admin.c.post(`/api/admin/ventures/${p1}/approve`, { managerId: manager.user.id });
  assert.equal(r.status, 200);
  assert.equal(r.json.venture.status, 'active');
  assert.equal(r.json.venture.managerId, manager.user.id);

  // Only pending ventures can be approved or rejected.
  assert.equal((await admin.c.post(`/api/admin/ventures/${p1}/approve`, {})).status, 400);
  assert.equal((await admin.c.post(`/api/admin/ventures/${p1}/reject`, {})).status, 400);

  // Reject the other pending venture.
  r = await admin.c.post(`/api/admin/ventures/${p2}/reject`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.venture.status, 'rejected');
  assert.equal((await admin.c.post(`/api/admin/ventures/${p2}/reject`, {})).status, 400);

  // Unknown / malformed ids.
  assert.equal((await admin.c.post('/api/admin/ventures/99999/approve', {})).status, 404);
  assert.equal((await admin.c.post('/api/admin/ventures/99999/reject', {})).status, 404);
  assert.equal((await admin.c.post('/api/admin/ventures/abc/approve', {})).status, 400);

  // Queue drains once both pending ventures are decided.
  const after = (await admin.c.get('/api/admin/overview')).json;
  assert.equal(after.needsAction.listings, 0);
  assert.equal(after.listingQueue.length, 0);
});

test('audit log: admin and manager can read, newest first, limit validated', async () => {
  const r = await admin.c.get('/api/admin/audit');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.entries) && r.json.entries.length > 0);
  for (let i = 1; i < r.json.entries.length; i++) {
    assert.ok(r.json.entries[i - 1].id > r.json.entries[i].id, 'entries must be newest first');
  }
  const actions = r.json.entries.map((e) => e.action);
  assert.ok(actions.includes('admin.user.update'));
  assert.ok(actions.includes('venture.approve'));
  assert.ok(actions.includes('venture.reject'));
  const approve = r.json.entries.find((e) => e.action === 'venture.approve');
  assert.equal(approve.actorId, admin.user.id);
  assert.equal(approve.actorHandle, 'admin');
  assert.match(approve.subject, /^venture:\d+$/);
  assert.equal(typeof approve.createdAt, 'string');

  // Managers can read the log too.
  assert.equal((await manager.c.get('/api/admin/audit')).status, 200);

  // limit is respected and validated.
  const limited = await admin.c.get('/api/admin/audit?limit=3');
  assert.equal(limited.json.entries.length, 3);
  assert.equal((await admin.c.get('/api/admin/audit?limit=0')).status, 400);
  assert.equal((await admin.c.get('/api/admin/audit?limit=abc')).status, 400);
  assert.equal((await admin.c.get('/api/admin/audit?limit=500')).status, 400);
});
