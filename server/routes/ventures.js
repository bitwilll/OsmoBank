import { db, tx, balance, audit } from '../db.js';
import {
  ApiError, str, num, oneOf, round2, requireAuth, requireRole,
} from '../lib/util.js';

const PAYOUT_FREQS = ['monthly', 'quarterly', 'annual'];

function ventureView(row) {
  const raised = round2(row.raised ?? 0);
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
    badge: row.badge,
    managerId: row.manager_id,
    payoutFreq: row.payout_freq,
    youHold: round2(row.you_hold ?? 0),
  };
}

const VENTURE_WITH_AGGREGATES = `
  SELECT v.*,
    COALESCE((SELECT SUM(i.amount) FROM investments i
              WHERE i.venture_id = v.id AND i.status = 'active'), 0) AS raised,
    COALESCE((SELECT SUM(i.amount) FROM investments i
              WHERE i.venture_id = v.id AND i.status = 'active' AND i.user_id = ?), 0) AS you_hold
  FROM ventures v`;

export default function mount(app) {
  app.get('/api/ventures', requireAuth, (req, res, next) => {
    try {
      const seesAll = req.user.role === 'admin' || req.user.role === 'manager';
      const rows = db.prepare(
        `${VENTURE_WITH_AGGREGATES}
         WHERE v.status IN ('active','closed') OR ? = 1
         ORDER BY v.id`)
        .all(req.user.id, seesAll ? 1 : 0);
      res.json({ ventures: rows.map(ventureView) });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures', requireRole('manager', 'admin'), (req, res, next) => {
    try {
      const name = str(req.body?.name, { min: 2, max: 80, name: 'name' });
      const sector = str(req.body?.sector, { min: 2, max: 40, name: 'sector' });
      const blurb = str(req.body?.blurb, { min: 1, max: 500, name: 'blurb' });
      const apy = num(req.body?.apy, { min: 0, max: 100, name: 'apy' });
      const minAmount = round2(num(req.body?.minAmount, { min: 0.01, max: 1e9, name: 'minAmount' }));
      const targetAmount = round2(num(req.body?.targetAmount, { min: 0.01, max: 1e12, name: 'targetAmount' }));
      if (targetAmount < minAmount) throw new ApiError(400, 'targetAmount must be at least minAmount');
      const payoutFreq = req.body?.payoutFreq !== undefined
        ? oneOf(req.body.payoutFreq, PAYOUT_FREQS, 'payoutFreq')
        : 'quarterly';

      let managerId = req.user.id;
      if (req.body?.managerId !== undefined) {
        const requested = num(req.body.managerId, { int: true, min: 1, name: 'managerId' });
        if (req.user.role !== 'admin' && requested !== req.user.id) {
          throw new ApiError(403, 'Only admins may assign another manager');
        }
        const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(requested);
        if (!target || !['manager', 'admin'].includes(target.role)) {
          throw new ApiError(400, 'managerId must reference a manager or admin');
        }
        managerId = target.id;
      }

      const venture = tx(() => {
        const id = Number(db.prepare(
          `INSERT INTO ventures (name, sector, blurb, apy, min_amount, target_amount, status, manager_id, payout_freq)
           VALUES (?,?,?,?,?,?,'pending',?,?)`)
          .run(name, sector, blurb, apy, minAmount, targetAmount, managerId, payoutFreq).lastInsertRowid);
        audit(req.user.id, 'venture.create', `venture:${id}`, name);
        return db.prepare(`${VENTURE_WITH_AGGREGATES} WHERE v.id = ?`).get(req.user.id, id);
      });
      res.status(201).json({ venture: ventureView(venture) });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures/:id/invest', requireAuth, (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const amount = round2(num(req.body?.amount, { min: 0.01, max: 1e9, name: 'amount' }));

      const out = tx(() => {
        const v = db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'Venture not found');
        if (v.status !== 'active') throw new ApiError(400, 'Venture is not open for investment');
        if (amount < v.min_amount) throw new ApiError(400, `Minimum investment is ${v.min_amount}`);
        if (balance(req.user.id, 'USDC') < amount) throw new ApiError(400, 'Insufficient balance');

        db.prepare(
          `INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo)
           VALUES (?,?,?,'invest','venture',?,?)`)
          .run(req.user.id, 'USDC', -amount, id, `Invested in ${v.name}`);
        const invId = Number(db.prepare(
          'INSERT INTO investments (user_id, venture_id, amount) VALUES (?,?,?)')
          .run(req.user.id, id, amount).lastInsertRowid);
        const inv = db.prepare('SELECT * FROM investments WHERE id = ?').get(invId);
        return { inv, bal: balance(req.user.id, 'USDC') };
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

  app.post('/api/ventures/:id/exit', requireAuth, (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });

      const returned = tx(() => {
        const v = db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'Venture not found');
        const stake = db.prepare(
          `SELECT COALESCE(SUM(amount),0) AS s FROM investments
           WHERE user_id = ? AND venture_id = ? AND status = 'active'`)
          .get(req.user.id, id).s;
        if (stake <= 0) throw new ApiError(400, 'No active stake in this venture');

        db.prepare(
          `UPDATE investments SET status = 'exited'
           WHERE user_id = ? AND venture_id = ? AND status = 'active'`)
          .run(req.user.id, id);
        const credit = round2(stake);
        db.prepare(
          `INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo)
           VALUES (?,?,?,'exit','venture',?,?)`)
          .run(req.user.id, 'USDC', credit, id, `Exited ${v.name}`);
        return credit;
      });

      res.json({ ok: true, returned });
    } catch (e) { next(e); }
  });

  app.post('/api/ventures/:id/payouts', requireAuth, (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const kind = oneOf(req.body?.kind, ['dividend', 'reimbursement'], 'kind');
      const total = round2(num(req.body?.total, { min: 0.01, max: 1e9, name: 'total' }));
      const memo = req.body?.memo !== undefined
        ? str(req.body.memo, { min: 1, max: 200, name: 'memo' })
        : null;

      const out = tx(() => {
        const v = db.prepare('SELECT * FROM ventures WHERE id = ?').get(id);
        if (!v) throw new ApiError(404, 'Venture not found');
        if (req.user.role !== 'admin' && v.manager_id !== req.user.id) {
          throw new ApiError(403, 'Only the venture manager or an admin may distribute payouts');
        }

        // Stake per user (largest first; ties broken by lowest user id).
        const stakes = db.prepare(
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

        const payoutId = Number(db.prepare(
          'INSERT INTO payouts (venture_id, kind, total, memo, created_by) VALUES (?,?,?,?,?)')
          .run(id, kind, total, memo, req.user.id).lastInsertRowid);
        const addItem = db.prepare(
          'INSERT INTO payout_items (payout_id, user_id, amount) VALUES (?,?,?)');
        const addLedger = db.prepare(
          `INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo)
           VALUES (?,?,?,?,'venture',?,?)`);
        for (const item of items) {
          addItem.run(payoutId, item.userId, item.amount);
          if (item.amount > 0) {
            addLedger.run(item.userId, 'USDC', item.amount, kind, id, memo ?? `${kind}: ${v.name}`);
          }
        }
        audit(req.user.id, 'venture.payout', `venture:${id}`,
          `${kind} ${total.toFixed(2)} across ${items.length} holders`);
        const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
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

  app.get('/api/ventures/:id/payouts', requireAuth, (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const v = db.prepare('SELECT id FROM ventures WHERE id = ?').get(id);
      if (!v) throw new ApiError(404, 'Venture not found');

      const rows = db.prepare(
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
