import { db, tx, audit } from '../db.js';
import {
  ApiError, str, num, oneOf, round2, requireRole, publicUser,
} from '../lib/util.js';

const ROLES = ['member', 'manager', 'admin'];
const STATUSES = ['active', 'review', 'frozen'];
const MEMBER_NO_BASE = 48195;

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

const ventureView = (v) => ({
  id: v.id, name: v.name, sector: v.sector, blurb: v.blurb, apy: v.apy,
  minAmount: v.min_amount, targetAmount: v.target_amount, status: v.status,
  badge: v.badge, managerId: v.manager_id, payoutFreq: v.payout_freq,
  createdAt: v.created_at,
});

export default function mount(app) {
  app.get('/api/admin/overview', requireRole('admin'), (req, res, next) => {
    try {
      const members = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      const membersThisWeek = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now','-7 days')").get().n;
      const treasury = round2(db.prepare(
        "SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE currency = 'USDC'").get().s);
      const volume24h = round2(db.prepare(
        "SELECT COALESCE(SUM(ABS(delta)),0) AS s FROM ledger WHERE currency = 'USDC' AND created_at >= datetime('now','-1 day')").get().s);
      const transfers24h = db.prepare(
        "SELECT COUNT(*) AS n FROM transfers WHERE created_at >= datetime('now','-1 day')").get().n;
      const kyc = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'review'").get().n;

      const listingQueue = db.prepare(
        "SELECT id, name, blurb, status FROM ventures WHERE status = 'pending' ORDER BY created_at ASC, id ASC").all()
        .map((v) => ({ ventureId: v.id, name: v.name, blurb: v.blurb, status: v.status }));

      const due = quarterEnd();
      const payoutQueue = db.prepare(
        `SELECT v.id, v.name, v.apy,
                COALESCE(SUM(i.amount), 0) AS raised,
                COUNT(DISTINCT i.user_id) AS holders
         FROM ventures v
         JOIN investments i ON i.venture_id = v.id AND i.status = 'active'
         WHERE v.status = 'active'
         GROUP BY v.id
         HAVING raised > 0
         ORDER BY raised DESC, v.id ASC`).all()
        .map((v) => ({
          ventureId: v.id, name: v.name, due,
          estTotal: round2((v.raised * v.apy) / 100 / 4), holders: v.holders,
        }));

      const newestMembers = db.prepare(
        'SELECT id, handle, role, status, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT 5').all()
        .map((u) => ({
          id: u.id, handle: u.handle, role: u.role, memberNo: MEMBER_NO_BASE + u.id,
          joinedAgo: joinedAgo(u.created_at),
          kyc: u.status === 'review' ? 'pending' : 'verified',
          status: u.status,
        }));

      // Synthetic but deterministic: derived from row counts, stable between calls.
      const ledgerRows = db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
      const signers = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role IN ('manager','admin')").get().n;
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

  app.get('/api/admin/users', requireRole('admin'), (req, res, next) => {
    try {
      const select = `SELECT u.*, COALESCE((SELECT SUM(l.delta) FROM ledger l
        WHERE l.user_id = u.id AND l.currency = 'USDC'), 0) AS bal FROM users u`;
      let rows;
      if (req.query.q !== undefined && String(req.query.q).trim() !== '') {
        const q = str(req.query.q, { min: 1, max: 60, name: 'q' }).toLowerCase().replace(/^@/, '');
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        rows = db.prepare(
          `${select} WHERE u.handle LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
           ORDER BY u.created_at DESC, u.id DESC LIMIT 100`).all(like, like, like);
      } else {
        rows = db.prepare(`${select} ORDER BY u.created_at DESC, u.id DESC LIMIT 100`).all();
      }
      res.json({ users: rows.map((u) => ({ ...publicUser(u), balance: round2(u.bal) })) });
    } catch (e) { next(e); }
  });

  app.patch('/api/admin/users/:id', requireRole('admin'), (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      const updates = {};
      if (req.body?.role !== undefined) updates.role = oneOf(req.body.role, ROLES, 'role');
      if (req.body?.status !== undefined) updates.status = oneOf(req.body.status, STATUSES, 'status');
      if (!Object.keys(updates).length) throw new ApiError(400, 'nothing to update');

      const user = tx(() => {
        const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!target) throw new ApiError(404, 'No such user');
        // Last-admin invariant: at least one USABLE admin must remain. Frozen
        // admins are not usable (login refuses them, loadSession revokes their
        // sessions), so only active admins other than the target count.
        const otherUsableAdmins = () => db.prepare(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?").get(id).n;
        if (updates.role !== undefined && updates.role !== target.role) {
          if (target.role === 'admin' && otherUsableAdmins() === 0) {
            throw new ApiError(400, 'Cannot demote the last admin');
          }
          if (id === req.user.id) throw new ApiError(400, 'You cannot change your own role');
          db.prepare('UPDATE users SET role = ? WHERE id = ?').run(updates.role, id);
        }
        if (updates.status !== undefined && updates.status !== target.status) {
          const roleNow = updates.role ?? target.role;
          if (updates.status === 'frozen' && roleNow === 'admin' && otherUsableAdmins() === 0) {
            throw new ApiError(400, 'Cannot freeze the last admin');
          }
          db.prepare('UPDATE users SET status = ? WHERE id = ?').run(updates.status, id);
          if (updates.status === 'frozen') {
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // sign out everywhere
          }
        }
        audit(req.user.id, 'admin.user.update', `user:${id}`,
          Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(','));
        return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      });
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/ventures/:id/approve', requireRole('admin'), (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      let managerId;
      if (req.body?.managerId !== undefined) {
        managerId = num(req.body.managerId, { min: 1, int: true, name: 'managerId' });
      }

      const venture = tx(() => {
        const v = db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'No such venture');
        if (v.status !== 'pending') throw new ApiError(400, 'Only pending ventures can be approved');
        if (managerId !== undefined) {
          const m = db.prepare('SELECT id, role FROM users WHERE id = ?').get(managerId);
          if (!m || !['manager', 'admin'].includes(m.role)) {
            throw new ApiError(400, 'managerId must be an existing manager or admin');
          }
          db.prepare('UPDATE ventures SET manager_id = ? WHERE id = ?').run(managerId, id);
        }
        db.prepare("UPDATE ventures SET status = 'active' WHERE id = ?").run(id);
        audit(req.user.id, 'venture.approve', `venture:${id}`,
          managerId !== undefined ? `managerId=${managerId}` : null);
        return db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
      });
      res.json({ venture: ventureView(venture) });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/ventures/:id/reject', requireRole('admin'), (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      const venture = tx(() => {
        const v = db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'No such venture');
        if (v.status !== 'pending') throw new ApiError(400, 'Only pending ventures can be rejected');
        db.prepare("UPDATE ventures SET status = 'rejected' WHERE id = ?").run(id);
        audit(req.user.id, 'venture.reject', `venture:${id}`);
        return db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
      });
      res.json({ venture: ventureView(venture) });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/audit', requireRole('admin', 'manager'), (req, res, next) => {
    try {
      const limit = req.query.limit !== undefined
        ? num(req.query.limit, { min: 1, max: 200, int: true, name: 'limit' })
        : 50;
      const rows = db.prepare(
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
