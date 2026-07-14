/* Support / Contact-us tickets.
 * - Members and visitors raise tickets from the contact form (POST /api/support).
 * - Operators read and close them (admin/manager).
 * - raiseTicket() is also called by the auth flow to notify an operator whenever
 *   a password reset is requested. */
import { db, audit } from '../db.js';
import { ApiError, str, num, oneOf, requireRole, rateLimit } from '../lib/util.js';

const CATEGORIES = ['account', 'payments', 'security', 'password_reset', 'troubleshooting', 'other'];
// Modest cap so the public contact form can't be used to flood the inbox.
const supportLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10 });

/** Insert a ticket. Reused by the password-reset flow (source:'system'). */
export async function raiseTicket({ userId = null, email = null, handle = null, category, message, source = 'user' }) {
  const id = Number((await db.prepare(
    'INSERT INTO support_tickets (user_id, email, handle, category, message, source) VALUES (?,?,?,?,?,?)')
    .run(userId, email, handle, category, message, source)).lastInsertRowid);
  await audit(userId, 'support.ticket', `ticket:${id}`, `${source}:${category}`);
  return id;
}

const ticketView = (t) => ({
  id: t.id, userId: t.user_id, userHandle: t.user_handle || t.handle || null,
  email: t.email, category: t.category, message: t.message,
  source: t.source, status: t.status, createdAt: t.created_at,
});

export default function mount(app) {
  app.post('/api/support', supportLimiter, async (req, res, next) => {
    try {
      const category = oneOf(String(req.body?.category || '').toLowerCase(), CATEGORIES, 'category');
      const message = str(req.body?.message, { min: 5, max: 2000, name: 'message' });
      let userId = null, email = null, handle = null;
      if (req.user) {
        userId = req.user.id; email = req.user.email; handle = req.user.handle;
      } else {
        // Anonymous contact: capture whatever the visitor gives us to reach them.
        if (req.body?.email != null && String(req.body.email).trim() !== '') {
          email = str(req.body.email, { min: 5, max: 120, name: 'email' }).toLowerCase();
        }
        if (req.body?.handle != null && String(req.body.handle).trim() !== '') {
          handle = str(req.body.handle, { min: 2, max: 25, name: 'handle' }).toLowerCase().replace(/^@/, '');
        }
      }
      const id = await raiseTicket({ userId, email, handle, category, message, source: 'user' });
      res.status(201).json({ ok: true, ref: id });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/support', requireRole('admin', 'manager'), async (req, res, next) => {
    try {
      const status = req.query.status !== undefined
        ? oneOf(String(req.query.status), ['open', 'closed', 'all'], 'status') : 'open';
      const limit = req.query.limit !== undefined
        ? num(req.query.limit, { min: 1, max: 200, int: true, name: 'limit' }) : 50;
      const base = `SELECT t.*, u.handle AS user_handle FROM support_tickets t
                    LEFT JOIN users u ON u.id = t.user_id`;
      const rows = status === 'all'
        ? await db.prepare(`${base} ORDER BY t.id DESC LIMIT ?`).all(limit)
        : await db.prepare(`${base} WHERE t.status = ? ORDER BY t.id DESC LIMIT ?`).all(status, limit);
      const open = (await db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'").get()).n;
      res.json({ tickets: rows.map(ticketView), openCount: open });
    } catch (e) { next(e); }
  });

  app.patch('/api/admin/support/:id', requireRole('admin', 'manager'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { min: 1, int: true, name: 'id' });
      const status = oneOf(String(req.body?.status || ''), ['open', 'closed'], 'status');
      const t = await db.prepare('SELECT id FROM support_tickets WHERE id = ?').get(id);
      if (!t) throw new ApiError(404, 'No such ticket');
      await db.prepare('UPDATE support_tickets SET status = ? WHERE id = ?').run(status, id);
      await audit(req.user.id, 'support.update', `ticket:${id}`, status);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
