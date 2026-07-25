import { db, tx, audit } from '../db.js';
import {
  ApiError, str, num, oneOf, round2, requireRole, publicUser,
} from '../lib/util.js';
import { computeStats, readStatOverrides, STAT_OVERRIDE_FIELDS } from './dao.js';
import {
  ventureView, ventureFields, assertVentureShape, VENTURE_STATUSES, VENTURE_WITH_AGGREGATES,
} from './ventures.js';

const ROLES = ['member', 'manager', 'admin'];
const STATUSES = ['active', 'review', 'frozen'];
const MEMBER_NO_BASE = 0; // member number is the real account id — no vanity offset

/** Humanize a UTC 'YYYY-MM-DD HH:MM:SS' timestamp as "3h ago" etc. */
function joinedAgo(createdAt) {
  const then = new Date(String(createdAt).replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** Last day of the current calendar quarter (UTC), as YYYY-MM-DD. */
function quarterEnd() {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  return new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10);
}

// Compact shape for the listing queue and approve/reject responses; the richer
// lifecycle view (phase, dates, raised) comes from ./ventures.js.
const queueVentureView = (v) => ({
  id: v.id, name: v.name, sector: v.sector, blurb: v.blurb, apy: v.apy,
  minAmount: v.min_amount, targetAmount: v.target_amount, status: v.status,
  badge: v.badge, managerId: v.manager_id, payoutFreq: v.payout_freq,
  createdAt: v.created_at,
});

export default function mount(app) {
  // ---- homepage numbers ("THE BANK, IN NUMBERS") -----------------------------
  // The operator may publish curated figures for the public stats. A blank
  // (absent/null) field always falls back to the live ledger value, and the
  // homepage labels curated figures as operator-published — never as computed.
  app.get('/api/admin/stats', requireRole('admin'), async (_req, res, next) => {
    try {
      res.json({ live: await computeStats(), overrides: await readStatOverrides() });
    } catch (e) { next(e); }
  });

  app.put('/api/admin/stats', requireRole('admin'), async (req, res, next) => {
    try {
      const overrides = {};
      for (const f of STAT_OVERRIDE_FIELDS) {
        const v = req.body?.[f];
        if (v === undefined || v === null || v === '') continue; // blank → live value
        overrides[f] = f === 'topApy'
          ? num(v, { min: 0, max: 100, name: f })
          : round2(num(v, { min: 0, max: 1e12, name: f }));
      }
      await db.prepare(
        "INSERT INTO meta (key, value) VALUES ('stats_overrides', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(overrides));
      const fields = Object.keys(overrides);
      await audit(req.user.id, 'stats.override', 'meta:stats_overrides',
        fields.length ? `set: ${fields.join(', ')}` : 'cleared — all figures live');
      res.json({ live: await computeStats(), overrides });
    } catch (e) { next(e); }
  });

  // ---- venture management ----------------------------------------------------
  // Full lifecycle for the console's Ventures tab: every venture regardless of
  // status, plus edits and status transitions. Creation stays on
  // POST /api/ventures (managers list their own; admins may list any).
  app.get('/api/admin/ventures', requireRole('admin', 'manager'), async (req, res, next) => {
    try {
      const rows = await db.prepare(`${VENTURE_WITH_AGGREGATES} ORDER BY v.id DESC`).all(req.user.id);
      const now = Date.now();
      const ventures = rows.map((r) => ({
        ...ventureView(r, now),
        holders: 0,
        createdAt: r.created_at,
      }));
      // Holder counts in one pass rather than a query per venture.
      const counts = await db.prepare(
        "SELECT venture_id, COUNT(DISTINCT user_id) AS n FROM investments WHERE status = 'active' GROUP BY venture_id").all();
      const byId = new Map(counts.map((c) => [Number(c.venture_id), Number(c.n)]));
      for (const v of ventures) v.holders = byId.get(v.id) ?? 0;
      res.json({ ventures });
    } catch (e) { next(e); }
  });

  app.patch('/api/admin/ventures/:id', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const fields = ventureFields(req.body, { partial: true });
      if (req.body?.status !== undefined) {
        fields.status = oneOf(String(req.body.status), VENTURE_STATUSES, 'status');
      }
      if (!Object.keys(fields).length) throw new ApiError(400, 'Nothing to update');

      const updated = await tx(async () => {
        const current = await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!current) throw new ApiError(404, 'Venture not found');
        // Validate the merged shape, so a partial edit cannot create an
        // impossible venture (target below minimum, closing before opening).
        assertVentureShape({ ...current, ...fields });
        if (fields.status === 'closed' && current.status !== 'closed') {
          const open = await db.prepare(
            "SELECT COUNT(*) AS n FROM investments WHERE venture_id = ? AND status = 'active'").get(id);
          if (Number(open.n) > 0 && req.body?.force !== true) {
            throw new ApiError(409, `${open.n} member stake(s) are still active — exit them first, or resend with force`);
          }
        }
        const cols = Object.keys(fields);
        await db.prepare(`UPDATE ventures SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .run(...cols.map((c) => fields[c]), id);
        await audit(req.user.id, 'venture.update', `venture:${id}`,
          cols.map((c) => `${c}=${fields[c] === null ? '—' : fields[c]}`).join(' · ').slice(0, 400));
        return await db.prepare(`${VENTURE_WITH_AGGREGATES} WHERE v.id = ?`).get(req.user.id, id);
      });
      res.json({ venture: ventureView(updated) });
    } catch (e) { next(e); }
  });

  // ---- governance ------------------------------------------------------------
  // Operators open votes and record outcomes. Tallies always come from real
  // votes (routes/dao.js); nothing here can manufacture support.
  app.post('/api/admin/proposals', requireRole('admin'), async (req, res, next) => {
    try {
      const title = str(req.body?.title, { min: 4, max: 160, name: 'title' });
      const blurb = req.body?.blurb ? str(req.body.blurb, { min: 1, max: 800, name: 'blurb' }) : '';
      const quorumPct = req.body?.quorumPct !== undefined
        ? num(req.body.quorumPct, { min: 1, max: 100, name: 'quorumPct' }) : 30;
      const days = req.body?.days !== undefined
        ? num(req.body.days, { min: 1, max: 90, int: true, name: 'days' }) : 7;
      const code = req.body?.code
        ? str(req.body.code, { min: 3, max: 20, name: 'code', pattern: /^[A-Za-z0-9-]+$/ }).toUpperCase()
        : null;

      const proposal = await tx(async () => {
        // Auto-number as OSM-0xx from the highest existing number.
        let finalCode = code;
        if (!finalCode) {
          const rows = await db.prepare("SELECT code FROM proposals WHERE code LIKE 'OSM-%'").all();
          const max = rows.reduce((m, r) => Math.max(m, Number(String(r.code).slice(4)) || 0), 0);
          finalCode = `OSM-${String(max + 1).padStart(3, '0')}`;
        }
        if (await db.prepare('SELECT 1 FROM proposals WHERE code = ?').get(finalCode)) {
          throw new ApiError(409, `Proposal ${finalCode} already exists`);
        }
        const id = Number((await db.prepare(
          `INSERT INTO proposals (code, title, blurb, status, quorum_pct, ends_at)
           VALUES (?,?,?,'live',?, datetime('now', ?))`)
          .run(finalCode, title, blurb, quorumPct, `+${days} days`)).lastInsertRowid);
        await audit(req.user.id, 'proposal.create', `proposal:${id}`, `${finalCode} · ${title}`);
        return await db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
      });
      res.status(201).json({ proposal });
    } catch (e) { next(e); }
  });

  app.patch('/api/admin/proposals/:id', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const fields = {};
      if (req.body?.title !== undefined) fields.title = str(req.body.title, { min: 4, max: 160, name: 'title' });
      if (req.body?.blurb !== undefined) fields.blurb = str(req.body.blurb, { min: 0, max: 800, name: 'blurb' });
      if (req.body?.quorumPct !== undefined) fields.quorum_pct = num(req.body.quorumPct, { min: 1, max: 100, name: 'quorumPct' });
      if (req.body?.status !== undefined) fields.status = oneOf(String(req.body.status), ['live', 'passed', 'rejected'], 'status');
      if (!Object.keys(fields).length && req.body?.days === undefined) throw new ApiError(400, 'Nothing to update');

      const proposal = await tx(async () => {
        const current = await db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
        if (!current) throw new ApiError(404, 'Proposal not found');
        const cols = Object.keys(fields);
        if (cols.length) {
          await db.prepare(`UPDATE proposals SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
            .run(...cols.map((c) => fields[c]), id);
        }
        if (req.body?.days !== undefined) {
          const days = num(req.body.days, { min: 1, max: 90, int: true, name: 'days' });
          await db.prepare("UPDATE proposals SET ends_at = datetime('now', ?) WHERE id = ?").run(`+${days} days`, id);
        }
        await audit(req.user.id, 'proposal.update', `proposal:${id}`,
          [...cols.map((c) => `${c}=${fields[c]}`), req.body?.days !== undefined ? `days=${req.body.days}` : null]
            .filter(Boolean).join(' · ').slice(0, 400));
        return await db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
      });
      res.json({ proposal });
    } catch (e) { next(e); }
  });

  // ---- risk ------------------------------------------------------------------
  /**
   * Live risk signals, every one computed from real rows. Each signal carries
   * its own count and a severity so the console can rank them; an empty list is
   * an honest "nothing to action" rather than a fabricated dashboard.
   */
  app.get('/api/admin/risk', requireRole('admin'), async (_req, res, next) => {
    try {
      const one = async (sql, args = []) => Number((await db.prepare(sql).get(...args))?.n ?? 0);
      const [frozen, review, kycPending, kycOldest, bigTransfers, overTarget,
        closingSoon, openTickets, staleLive, multiSession] = await Promise.all([
        one("SELECT COUNT(*) AS n FROM users WHERE status = 'frozen'"),
        one("SELECT COUNT(*) AS n FROM users WHERE status = 'review'"),
        one("SELECT COUNT(*) AS n FROM kyc_submissions WHERE status = 'pending'"),
        one("SELECT CAST(julianday('now') - julianday(MIN(created_at)) AS INTEGER) AS n FROM kyc_submissions WHERE status = 'pending'"),
        one("SELECT COUNT(*) AS n FROM transfers WHERE amount >= 10000 AND created_at >= datetime('now','-1 day')"),
        one(`SELECT COUNT(*) AS n FROM ventures v WHERE v.status = 'active'
               AND (SELECT COALESCE(SUM(amount),0) FROM investments i WHERE i.venture_id = v.id AND i.status = 'active') > v.target_amount`),
        one("SELECT COUNT(*) AS n FROM ventures WHERE status = 'active' AND closes_at IS NOT NULL AND date(closes_at) <= date('now','+7 days') AND date(closes_at) >= date('now')"),
        one("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'"),
        one("SELECT COUNT(*) AS n FROM proposals WHERE status = 'live' AND ends_at IS NOT NULL AND datetime(ends_at) < datetime('now')"),
        one(`SELECT COUNT(*) AS n FROM (SELECT user_id FROM sessions WHERE expires_at > datetime('now')
               GROUP BY user_id HAVING COUNT(*) >= 3)`),
      ]);

      const signals = [
        { key: 'kyc_backlog', label: 'KYC submissions awaiting review', count: kycPending,
          severity: kycPending === 0 ? 'ok' : (kycOldest >= 3 ? 'high' : 'medium'),
          detail: kycPending ? `oldest waiting ${kycOldest} day(s)` : 'queue clear', action: 'kyc' },
        { key: 'accounts_review', label: 'Accounts held for review', count: review,
          severity: review === 0 ? 'ok' : 'medium', detail: 'cannot transact until cleared', action: 'members' },
        { key: 'accounts_frozen', label: 'Frozen accounts', count: frozen,
          severity: frozen === 0 ? 'ok' : 'low', detail: 'access suspended', action: 'members' },
        { key: 'large_transfers', label: 'Transfers ≥ $10,000 (24h)', count: bigTransfers,
          severity: bigTransfers === 0 ? 'ok' : 'medium', detail: 'review for source of funds', action: null },
        { key: 'over_target', label: 'Ventures raised past target', count: overTarget,
          severity: overTarget === 0 ? 'ok' : 'high', detail: 'close or raise the target', action: 'ventures' },
        { key: 'closing_soon', label: 'Ventures closing within 7 days', count: closingSoon,
          severity: closingSoon === 0 ? 'ok' : 'low', detail: 'confirm the closing plan', action: 'ventures' },
        { key: 'stale_votes', label: 'Live votes past their end date', count: staleLive,
          severity: staleLive === 0 ? 'ok' : 'high', detail: 'record the outcome', action: 'proposals' },
        { key: 'open_tickets', label: 'Open support tickets', count: openTickets,
          severity: openTickets === 0 ? 'ok' : 'medium', detail: 'members awaiting a reply', action: 'support' },
        { key: 'multi_session', label: 'Accounts live on 3+ devices', count: multiSession,
          severity: multiSession === 0 ? 'ok' : 'low', detail: 'possible shared credentials', action: 'members' },
      ];
      const rank = { high: 3, medium: 2, low: 1, ok: 0 };
      signals.sort((a, b) => rank[b.severity] - rank[a.severity] || b.count - a.count);
      res.json({
        signals,
        needsAction: signals.filter((s) => s.severity !== 'ok').length,
        checkedAt: new Date().toISOString(),
      });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/overview', requireRole('admin'), async (req, res, next) => {
    try {
      const members = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
      const membersThisWeek = (await db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now','-7 days')").get()).n;
      const treasury = round2((await db.prepare(
        "SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE currency = 'USDC'").get()).s);
      const volume24h = round2((await db.prepare(
        "SELECT COALESCE(SUM(ABS(delta)),0) AS s FROM ledger WHERE currency = 'USDC' AND created_at >= datetime('now','-1 day')").get()).s);
      const transfers24h = (await db.prepare(
        "SELECT COUNT(*) AS n FROM transfers WHERE created_at >= datetime('now','-1 day')").get()).n;
      // "KYC" on the overview means work waiting in the Osmo Assure queue, so it
      // agrees with the KYC tab and the risk board. Accounts merely held for
      // review are counted separately (see the accounts_review risk signal).
      const kyc = Number((await db.prepare(
        "SELECT COUNT(*) AS n FROM kyc_submissions WHERE status = 'pending'").get()).n);

      const listingQueue = (await db.prepare(
        "SELECT id, name, blurb, status FROM ventures WHERE status = 'pending' ORDER BY created_at ASC, id ASC").all())
        .map((v) => ({ ventureId: v.id, name: v.name, blurb: v.blurb, status: v.status }));

      const due = quarterEnd();
      const payoutQueue = (await db.prepare(
        `SELECT v.id, v.name, v.apy,
                COALESCE(SUM(i.amount), 0) AS raised,
                COUNT(DISTINCT i.user_id) AS holders
         FROM ventures v
         JOIN investments i ON i.venture_id = v.id AND i.status = 'active'
         WHERE v.status = 'active'
         GROUP BY v.id
         HAVING raised > 0
         ORDER BY raised DESC, v.id ASC`).all())
        .map((v) => ({
          ventureId: v.id, name: v.name, due,
          estTotal: round2((v.raised * v.apy) / 100 / 4), holders: v.holders,
        }));

      // Verification comes from the member's most recent Osmo Assure submission,
      // not from their account status: an ordinary active account that has never
      // submitted anything is "none", never a tick.
      const newestMembers = (await db.prepare(
        `SELECT u.id, u.handle, u.role, u.status, u.created_at,
                (SELECT k.status FROM kyc_submissions k
                  WHERE k.user_id = u.id ORDER BY k.id DESC LIMIT 1) AS kyc_status
           FROM users u ORDER BY u.created_at DESC, u.id DESC LIMIT 5`).all())
        .map((u) => ({
          id: u.id, handle: u.handle, role: u.role, memberNo: MEMBER_NO_BASE + u.id,
          joinedAgo: joinedAgo(u.created_at),
          kyc: u.kyc_status === 'approved' ? 'verified'
            : (u.kyc_status === 'pending' ? 'pending' : (u.kyc_status ?? 'none')),
          status: u.status,
        }));

      // Synthetic but deterministic: derived from row counts, stable between calls.
      const ledgerRows = (await db.prepare('SELECT COUNT(*) AS n FROM ledger').get()).n;
      const signers = (await db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role IN ('manager','admin')").get()).n;
      const network = {
        block: 1842000 + ledgerRows,
        latencyMs: 12 + (ledgerRows % 28),
        uptimePct: round2(99.95 + (members % 5) / 100),
        signers,
      };

      res.json({
        members, membersThisWeek, treasury, volume24h, transfers24h,
        needsAction: { listings: listingQueue.length, payoutsDue: payoutQueue.length, kyc },
        listingQueue, payoutQueue, newestMembers, network,
      });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/users', requireRole('admin'), async (req, res, next) => {
    try {
      const select = `SELECT u.*, COALESCE((SELECT SUM(l.delta) FROM ledger l
        WHERE l.user_id = u.id AND l.currency = 'USDC'), 0) AS bal FROM users u`;
      let rows;
      if (req.query.q !== undefined && String(req.query.q).trim() !== '') {
        const q = str(req.query.q, { min: 1, max: 60, name: 'q' }).toLowerCase().replace(/^@/, '');
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        rows = await db.prepare(
          `${select} WHERE u.handle LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
           ORDER BY u.created_at DESC, u.id DESC LIMIT 100`).all(like, like, like);
      } else {
        rows = await db.prepare(`${select} ORDER BY u.created_at DESC, u.id DESC LIMIT 100`).all();
      }
      res.json({ users: rows.map((u) => ({ ...publicUser(u), balance: round2(u.bal) })) });
    } catch (e) { next(e); }
  });

  app.patch('/api/admin/users/:id', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      const updates = {};
      if (req.body?.role !== undefined) updates.role = oneOf(req.body.role, ROLES, 'role');
      if (req.body?.status !== undefined) updates.status = oneOf(req.body.status, STATUSES, 'status');
      if (!Object.keys(updates).length) throw new ApiError(400, 'nothing to update');

      const user = await tx(async () => {
        const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!target) throw new ApiError(404, 'No such user');
        // Last-admin invariant: at least one USABLE admin must remain. Frozen
        // admins are not usable (login refuses them, loadSession revokes their
        // sessions), so only active admins other than the target count.
        const otherUsableAdmins = async () => (await db.prepare(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?").get(id)).n;
        if (updates.role !== undefined && updates.role !== target.role) {
          if (target.role === 'admin' && await otherUsableAdmins() === 0) {
            throw new ApiError(400, 'Cannot demote the last admin');
          }
          if (id === req.user.id) throw new ApiError(400, 'You cannot change your own role');
          await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(updates.role, id);
        }
        if (updates.status !== undefined && updates.status !== target.status) {
          const roleNow = updates.role ?? target.role;
          if (updates.status === 'frozen' && roleNow === 'admin' && await otherUsableAdmins() === 0) {
            throw new ApiError(400, 'Cannot freeze the last admin');
          }
          await db.prepare('UPDATE users SET status = ? WHERE id = ?').run(updates.status, id);
          if (updates.status === 'frozen') {
            await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // sign out everywhere
          }
        }
        await audit(req.user.id, 'admin.user.update', `user:${id}`,
          Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(','));
        return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      });
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/ventures/:id/approve', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      let managerId;
      if (req.body?.managerId !== undefined) {
        managerId = num(req.body.managerId, { min: 1, int: true, name: 'managerId' });
      }

      const venture = await tx(async () => {
        const v = await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'No such venture');
        if (v.status !== 'pending') throw new ApiError(400, 'Only pending ventures can be approved');
        if (managerId !== undefined) {
          const m = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(managerId);
          if (!m || !['manager', 'admin'].includes(m.role)) {
            throw new ApiError(400, 'managerId must be an existing manager or admin');
          }
          await db.prepare('UPDATE ventures SET manager_id = ? WHERE id = ?').run(managerId, id);
        }
        await db.prepare("UPDATE ventures SET status = 'active' WHERE id = ?").run(id);
        await audit(req.user.id, 'venture.approve', `venture:${id}`,
          managerId !== undefined ? `managerId=${managerId}` : null);
        return await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
      });
      res.json({ venture: queueVentureView(venture) });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/ventures/:id/reject', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      const venture = await tx(async () => {
        const v = await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'No such venture');
        if (v.status !== 'pending') throw new ApiError(400, 'Only pending ventures can be rejected');
        await db.prepare("UPDATE ventures SET status = 'rejected' WHERE id = ?").run(id);
        await audit(req.user.id, 'venture.reject', `venture:${id}`);
        return await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
      });
      res.json({ venture: queueVentureView(venture) });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/audit', requireRole('admin', 'manager'), async (req, res, next) => {
    try {
      const limit = req.query.limit !== undefined
        ? num(req.query.limit, { min: 1, max: 200, int: true, name: 'limit' })
        : 50;
      const rows = await db.prepare(
        `SELECT a.id, a.actor_id, a.action, a.subject, a.detail, a.created_at, u.handle AS actor_handle
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.id DESC LIMIT ?`).all(limit);
      res.json({
        entries: rows.map((r) => ({
          id: r.id, actorId: r.actor_id, actorHandle: r.actor_handle ?? null,
          action: r.action, subject: r.subject, detail: r.detail, createdAt: r.created_at,
        })),
      });
    } catch (e) { next(e); }
  });
}
