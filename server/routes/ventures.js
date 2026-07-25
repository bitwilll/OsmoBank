import { db, tx, balance, audit } from '../db.js';
import {
  ApiError, str, num, oneOf, round2, requireAuth, requireRole,
} from '../lib/util.js';

const PAYOUT_FREQS = ['monthly', 'quarterly', 'annual'];
const VENTURE_STATUSES = ['pending', 'active', 'closed', 'rejected'];

/** 'YYYY-MM-DD' (or a full timestamp) → epoch ms at UTC midnight, or null. */
function dayMs(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Where a venture sits in its lifecycle, derived from real dates rather than a
 * hand-typed badge:
 *   pending  — submitted, awaiting operator approval (not public)
 *   upcoming — approved and announced, opens on a future date
 *   live     — open for investment right now
 *   closed   — past its closing date, or closed by an operator
 */
function venturePhase(row, now = Date.now()) {
  if (row.status !== 'active') return row.status === 'closed' ? 'closed' : row.status;
  const opens = dayMs(row.opens_at);
  const closes = dayMs(row.closes_at);
  if (closes !== null && now >= closes + 86400000) return 'closed'; // closing day inclusive
  if (opens !== null && now < opens) return 'upcoming';
  return 'live';
}

function ventureView(row, now = Date.now()) {
  const raised = round2(row.raised ?? 0);
  const phase = venturePhase(row, now);
  const opens = dayMs(row.opens_at);
  return {
    id: row.id,
    name: row.name,
    sector: row.sector,
    blurb: row.blurb,
    apy: row.apy,
    minAmount: row.min_amount,
    targetAmount: row.target_amount,
    raised,
    filledPct: row.target_amount > 0 ? round2((raised / row.target_amount) * 100) : 0,
    status: row.status,
    phase,
    opensAt: row.opens_at ?? null,
    closesAt: row.closes_at ?? null,
    daysUntilOpen: phase === 'upcoming' && opens !== null
      ? Math.max(0, Math.ceil((opens - now) / 86400000)) : null,
    investable: phase === 'live',
    badge: row.badge,
    managerId: row.manager_id,
    payoutFreq: row.payout_freq,
    youHold: round2(row.you_hold ?? 0),
  };
}

/** Shared validation for the create and edit payloads. */
function ventureFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body?.[k] !== undefined && body[k] !== null;
  // On create every core field is required, so a missing one is validated (and
  // rejected with a 400) rather than skipped; a partial edit only touches what
  // the caller actually sent.
  const need = (k) => !partial || has(k);
  if (need('name')) out.name = str(body?.name, { min: 2, max: 80, name: 'name' });
  if (need('sector')) out.sector = str(body?.sector, { min: 2, max: 40, name: 'sector' }).toUpperCase();
  if (need('blurb')) out.blurb = str(body?.blurb, { min: 1, max: 500, name: 'blurb' });
  if (need('apy')) out.apy = num(body?.apy, { min: 0, max: 100, name: 'apy' });
  if (need('minAmount')) out.min_amount = round2(num(body?.minAmount, { min: 0.01, max: 1e9, name: 'minAmount' }));
  if (need('targetAmount')) out.target_amount = round2(num(body?.targetAmount, { min: 0.01, max: 1e12, name: 'targetAmount' }));
  if (has('payoutFreq')) out.payout_freq = oneOf(body.payoutFreq, PAYOUT_FREQS, 'payoutFreq');
  if (has('badge')) out.badge = str(body.badge, { min: 1, max: 40, name: 'badge' });
  else if (body?.badge === null || body?.badge === '') out.badge = null;
  for (const [key, col] of [['opensAt', 'opens_at'], ['closesAt', 'closes_at']]) {
    if (body?.[key] === null || body?.[key] === '') { out[col] = null; continue; }
    if (!has(key)) continue;
    const d = str(body[key], { min: 10, max: 10, name: key, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    if (dayMs(d) === null) throw new ApiError(400, `${key} is not a real date`);
    out[col] = d;
  }
  return out;
}

function assertVentureShape(v) {
  if (v.target_amount !== undefined && v.min_amount !== undefined && v.target_amount < v.min_amount) {
    throw new ApiError(400, 'targetAmount must be at least minAmount');
  }
  if (v.opens_at && v.closes_at && dayMs(v.closes_at) < dayMs(v.opens_at)) {
    throw new ApiError(400, 'closesAt must be on or after opensAt');
  }
}


const VENTURE_WITH_AGGREGATES = `
  SELECT v.*,
    COALESCE((SELECT SUM(i.amount) FROM investments i
              WHERE i.venture_id = v.id AND i.status = 'active'), 0) AS raised,
    COALESCE((SELECT SUM(i.amount) FROM investments i
              WHERE i.venture_id = v.id AND i.status = 'active' AND i.user_id = ?), 0) AS you_hold
  FROM ventures v`;

export { ventureView, venturePhase, ventureFields, assertVentureShape, VENTURE_STATUSES, VENTURE_WITH_AGGREGATES };

export default function mount(app) {
  // Public read: the venture floor is the DAO's storefront, and the payload
  // holds no member data — `youHold` is simply 0 for anonymous visitors.
  // Upcoming ventures (approved, opening on a future date) are public too, so
  // the pipeline is visible; ventures still awaiting approval are not.
  app.get('/api/ventures', async (req, res, next) => {
    try {
      const seesAll = req.user && ['admin', 'manager'].includes(req.user.role);
      const rows = await db.prepare(
        `${VENTURE_WITH_AGGREGATES}
         WHERE v.status IN ('active','closed') OR ? = 1
         ORDER BY v.id`)
        .all(req.user?.id ?? 0, seesAll ? 1 : 0);
      const now = Date.now();
      res.json({ ventures: rows.map((r) => ventureView(r, now)) });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures', requireRole('manager', 'admin'), async (req, res, next) => {
    try {
      const f = ventureFields(req.body);
      assertVentureShape(f);
      const { name, sector, blurb, apy } = f;
      const minAmount = f.min_amount;
      const targetAmount = f.target_amount;
      const payoutFreq = f.payout_freq ?? 'quarterly';

      let managerId = req.user.id;
      if (req.body?.managerId !== undefined) {
        const requested = num(req.body.managerId, { int: true, min: 1, name: 'managerId' });
        if (req.user.role !== 'admin' && requested !== req.user.id) {
          throw new ApiError(403, 'Only admins may assign another manager');
        }
        const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(requested);
        if (!target || !['manager', 'admin'].includes(target.role)) {
          throw new ApiError(400, 'managerId must reference a manager or admin');
        }
        managerId = target.id;
      }

      const venture = await tx(async () => {
        const id = Number((await db.prepare(
          `INSERT INTO ventures (name, sector, blurb, apy, min_amount, target_amount, status, manager_id, payout_freq, opens_at, closes_at, badge)
           VALUES (?,?,?,?,?,?,'pending',?,?,?,?,?)`)
          .run(name, sector, blurb, apy, minAmount, targetAmount, managerId, payoutFreq,
            f.opens_at ?? null, f.closes_at ?? null, f.badge ?? null)).lastInsertRowid);
        await audit(req.user.id, 'venture.create', `venture:${id}`, name);
        return await db.prepare(`${VENTURE_WITH_AGGREGATES} WHERE v.id = ?`).get(req.user.id, id);
      });
      res.status(201).json({ venture: ventureView(venture) });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures/:id/invest', requireAuth, async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const amount = round2(num(req.body?.amount, { min: 0.01, max: 1e9, name: 'amount' }));

      const out = await tx(async () => {
        const v = await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'Venture not found');
        const phase = venturePhase(v);
        if (phase === 'upcoming') throw new ApiError(400, `This venture opens on ${String(v.opens_at).slice(0, 10)}`);
        if (phase !== 'live') throw new ApiError(400, 'Venture is not open for investment');
        if (amount < v.min_amount) throw new ApiError(400, `Minimum investment is ${v.min_amount}`);
        if (await balance(req.user.id, 'USDC') < amount) throw new ApiError(400, 'Insufficient balance');

        await db.prepare(
          `INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo)
           VALUES (?,?,?,'invest','venture',?,?)`)
          .run(req.user.id, 'USDC', -amount, id, `Invested in ${v.name}`);
        const invId = Number((await db.prepare(
          'INSERT INTO investments (user_id, venture_id, amount) VALUES (?,?,?)')
          .run(req.user.id, id, amount)).lastInsertRowid);
        const inv = await db.prepare('SELECT * FROM investments WHERE id = ?').get(invId);
        return { inv, bal: await balance(req.user.id, 'USDC') };
      });

      res.status(201).json({
        investment: {
          id: out.inv.id,
          userId: out.inv.user_id,
          ventureId: out.inv.venture_id,
          amount: out.inv.amount,
          status: out.inv.status,
          createdAt: out.inv.created_at,
        },
        balance: out.bal,
      });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures/:id/exit', requireAuth, async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });

      const returned = await tx(async () => {
        const v = await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'Venture not found');
        const stake = (await db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS s FROM investments
           WHERE user_id = ? AND venture_id = ? AND status = 'active'`)
          .get(req.user.id, id)).s;
        if (stake <= 0) throw new ApiError(400, 'No active stake in this venture');

        await db.prepare(
          `UPDATE investments SET status = 'exited'
           WHERE user_id = ? AND venture_id = ? AND status = 'active'`)
          .run(req.user.id, id);
        const credit = round2(stake);
        await db.prepare(
          `INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo)
           VALUES (?,?,?,'exit','venture',?,?)`)
          .run(req.user.id, 'USDC', credit, id, `Exited ${v.name}`);
        return credit;
      });

      res.json({ ok: true, returned });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures/:id/payouts', requireAuth, async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const kind = oneOf(req.body?.kind, ['dividend', 'reimbursement'], 'kind');
      const total = round2(num(req.body?.total, { min: 0.01, max: 1e9, name: 'total' }));
      const memo = req.body?.memo !== undefined
        ? str(req.body.memo, { min: 1, max: 200, name: 'memo' })
        : null;

      const out = await tx(async () => {
        const v = await db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'Venture not found');
        if (req.user.role !== 'admin' && v.manager_id !== req.user.id) {
          throw new ApiError(403, 'Only the venture manager or an admin may distribute payouts');
        }

        // Stake per user (largest first; ties broken by lowest user id).
        const stakes = await db.prepare(
          `SELECT user_id, SUM(amount) AS stake FROM investments
           WHERE venture_id = ? AND status = 'active'
           GROUP BY user_id ORDER BY stake DESC, user_id ASC`).all(id);
        if (!stakes.length) throw new ApiError(400, 'No active investments to distribute to');

        const totalStake = stakes.reduce((s, r) => s + r.stake, 0);
        // Work in integer cents so rounding can never fabricate or destroy money.
        const totalCents = Math.round(total * 100);
        const shares = stakes.map((r) => ({
          userId: r.user_id,
          cents: Math.round(((total * r.stake) / totalStake) * 100),
        }));
        const remainder = totalCents - shares.reduce((s, i) => s + i.cents, 0);
        if (remainder > 0) {
          // Leftover cents go to the largest stakeholder (ties: lowest user id).
          shares[0].cents += remainder;
        } else if (remainder < 0) {
          // Rounding overshot the total: claw the excess back starting from the
          // largest stakeholder, but never push any share below zero — a
          // distribution is a CREDIT and must never debit a member.
          let excess = -remainder;
          for (const share of shares) {
            const take = Math.min(share.cents, excess);
            share.cents -= take;
            excess -= take;
            if (excess === 0) break;
          }
        }
        const items = shares.map((s) => ({ userId: s.userId, amount: round2(s.cents / 100) }));

        const payoutId = Number((await db.prepare(
          'INSERT INTO payouts (venture_id, kind, total, memo, created_by) VALUES (?,?,?,?,?)')
          .run(id, kind, total, memo, req.user.id)).lastInsertRowid);
        const addItem = db.prepare(
          'INSERT INTO payout_items (payout_id, user_id, amount) VALUES (?,?,?)');
        const addLedger = db.prepare(
          `INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo)
           VALUES (?,?,?,?,'venture',?,?)`);
        for (const item of items) {
          await addItem.run(payoutId, item.userId, item.amount);
          if (item.amount > 0) {
            await addLedger.run(item.userId, 'USDC', item.amount, kind, id, memo ?? `${kind}: ${v.name}`);
          }
        }
        await audit(req.user.id, 'venture.payout', `venture:${id}`,
          `${kind} ${total.toFixed(2)} across ${items.length} holders`);
        const payout = await db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
        return { payout, items };
      });

      res.status(201).json({
        payout: {
          id: out.payout.id,
          ventureId: out.payout.venture_id,
          kind: out.payout.kind,
          total: out.payout.total,
          memo: out.payout.memo,
          createdBy: out.payout.created_by,
          createdAt: out.payout.created_at,
        },
        items: out.items,
      });
    } catch (e) { next(e); }
  });

  app.get('/api/ventures/:id/payouts', requireAuth, async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const v = await db.prepare('SELECT id FROM ventures WHERE id = ?').get(id);
      if (!v) throw new ApiError(404, 'Venture not found');

      const rows = await db.prepare(
        `SELECT p.id, p.kind, p.total, p.memo, p.created_at,
           COALESCE((SELECT SUM(pi.amount) FROM payout_items pi
                     WHERE pi.payout_id = p.id AND pi.user_id = ?), 0) AS your_share
         FROM payouts p WHERE p.venture_id = ? ORDER BY p.id DESC`)
        .all(req.user.id, id);
      res.json({
        payouts: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          total: r.total,
          memo: r.memo,
          createdAt: r.created_at,
          yourShare: round2(r.your_share),
        })),
      });
    } catch (e) { next(e); }
  });
}
