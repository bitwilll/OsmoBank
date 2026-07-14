import { db, tx, balance, audit } from '../db.js';
import { ApiError, str, num, oneOf, round2, requireAuth } from '../lib/util.js';

const HANDLE_RE = /^[a-z0-9_]{2,24}$/;
const TXID_RE = /^[0-9a-f]{8,128}$/i;
const CURRENCY_RE = /^[A-Z0-9]{2,10}$/;
const EXTERNAL_CHAINS = ['btc-testnet', 'eth-sepolia', 'btc', 'eth', 'sol', 'usdc'];
const MAX_AMOUNT = 1e9;

function goalOut(g) {
  return {
    id: g.id,
    name: g.name,
    category: g.category,
    icon: g.icon,
    target: g.target,
    saved: g.saved,
    autosave: g.autosave,
    eta: g.eta,
    pct: g.target > 0 ? round2((g.saved / g.target) * 100) : 0,
    createdAt: g.created_at,
  };
}

/** Load a goal by :id, 404 if missing, 403 if owned by someone else. */
async function loadOwnGoal(rawId, user) {
  const id = num(rawId, { min: 1, int: true, name: 'id' });
  const goal = await db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!goal) throw new ApiError(404, 'Goal not found');
  if (goal.user_id !== user.id) throw new ApiError(403, 'Not permitted');
  return goal;
}

const TRANSFER_SELECT = `
  SELECT t.*, fu.handle AS from_handle, tu.handle AS to_handle
  FROM transfers t
  LEFT JOIN users fu ON fu.id = t.from_user
  LEFT JOIN users tu ON tu.id = t.to_user`;

function transferOut(row, meId) {
  const direction = row.from_user === meId ? 'out' : 'in';
  const internal = row.chain === 'internal';
  return {
    id: row.id,
    direction,
    fromUser: row.from_user,
    toUser: row.to_user,
    chain: row.chain,
    toAddress: row.to_address,
    currency: row.currency,
    amount: row.amount,
    txid: row.txid,
    status: row.status,
    counterparty: internal ? (direction === 'out' ? row.to_handle : row.from_handle) : null,
    createdAt: row.created_at,
  };
}

export default function mount(app) {
  // ---- goals ---------------------------------------------------------------

  app.get('/api/goals', requireAuth, async (req, res) => {
    const rows = await db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id').all(req.user.id);
    res.json({ goals: rows.map(goalOut) });
  });

  app.post('/api/goals', requireAuth, async (req, res, next) => {
    try {
      const name = str(req.body?.name, { min: 1, max: 60, name: 'name' });
      const target = round2(num(req.body?.target, { min: 0.01, max: MAX_AMOUNT, name: 'target' }));
      const category = req.body?.category === undefined
        ? 'SAVINGS'
        : str(req.body.category, { min: 1, max: 24, name: 'category' }).toUpperCase();
      const icon = req.body?.icon === undefined
        ? 'flag'
        : str(req.body.icon, { min: 1, max: 32, name: 'icon' });
      const autosave = req.body?.autosave === undefined
        ? 0
        : round2(num(req.body.autosave, { min: 0, max: MAX_AMOUNT, name: 'autosave' }));

      const goal = await tx(async () => {
        const id = Number((await db.prepare(
          'INSERT INTO goals (user_id, name, category, icon, target, autosave) VALUES (?,?,?,?,?,?)')
          .run(req.user.id, name, category, icon, target, autosave)).lastInsertRowid);
        await audit(req.user.id, 'goal.create', `goal:${id}`, name);
        return await db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
      });
      res.status(201).json({ goal: goalOut(goal) });
    } catch (e) { next(e); }
  });

  app.patch('/api/goals/:id', requireAuth, async (req, res, next) => {
    try {
      const updates = {};
      if (req.body?.name !== undefined) {
        updates.name = str(req.body.name, { min: 1, max: 60, name: 'name' });
      }
      if (req.body?.target !== undefined) {
        updates.target = round2(num(req.body.target, { min: 0.01, max: MAX_AMOUNT, name: 'target' }));
      }
      if (req.body?.autosave !== undefined) {
        updates.autosave = round2(num(req.body.autosave, { min: 0, max: MAX_AMOUNT, name: 'autosave' }));
      }
      const addSaved = req.body?.addSaved === undefined
        ? 0
        : round2(num(req.body.addSaved, { min: 0.01, max: MAX_AMOUNT, name: 'addSaved' }));
      if (!Object.keys(updates).length && !addSaved) throw new ApiError(400, 'nothing to update');

      const goal = await tx(async () => {
        const g = await loadOwnGoal(req.params.id, req.user);
        if (updates.name !== undefined) {
          await db.prepare('UPDATE goals SET name = ? WHERE id = ?').run(updates.name, g.id);
        }
        if (updates.target !== undefined) {
          await db.prepare('UPDATE goals SET target = ? WHERE id = ?').run(updates.target, g.id);
        }
        if (updates.autosave !== undefined) {
          await db.prepare('UPDATE goals SET autosave = ? WHERE id = ?').run(updates.autosave, g.id);
        }
        if (addSaved) {
          if (await balance(req.user.id, 'USDC') < addSaved) {
            throw new ApiError(400, 'Insufficient USDC balance');
          }
          await db.prepare(
            "INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,?,?,'adjust','goal',?,?)")
            .run(req.user.id, 'USDC', -addSaved, g.id, 'goal contribution');
          await db.prepare('UPDATE goals SET saved = ? WHERE id = ?').run(round2(g.saved + addSaved), g.id);
        }
        const changed = [...Object.keys(updates), ...(addSaved ? ['addSaved'] : [])].join(',');
        await audit(req.user.id, 'goal.update', `goal:${g.id}`, changed);
        return await db.prepare('SELECT * FROM goals WHERE id = ?').get(g.id);
      });
      res.json({ goal: goalOut(goal) });
    } catch (e) { next(e); }
  });

  app.delete('/api/goals/:id', requireAuth, async (req, res, next) => {
    try {
      await tx(async () => {
        const g = await loadOwnGoal(req.params.id, req.user);
        if (g.saved > 0) {
          await db.prepare(
            "INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,?,?,'adjust','goal',?,?)")
            .run(req.user.id, 'USDC', round2(g.saved), g.id, 'goal refund');
        }
        await db.prepare('DELETE FROM goals WHERE id = ?').run(g.id);
        await audit(req.user.id, 'goal.delete', `goal:${g.id}`, g.name);
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- transfers -----------------------------------------------------------

  app.post('/api/transfers', requireAuth, async (req, res, next) => {
    try {
      const to = str(req.body?.to, { min: 2, max: 25, name: 'to' })
        .toLowerCase().replace(/^@/, '');
      if (!HANDLE_RE.test(to)) throw new ApiError(400, 'to must be a member @handle');
      const amount = round2(num(req.body?.amount, { min: 0.01, max: MAX_AMOUNT, name: 'amount' }));
      const currency = req.body?.currency === undefined
        ? 'USDC'
        : oneOf(req.body.currency, ['USDC', 'OSM'], 'currency');

      const tid = await tx(async () => {
        const recipient = await db.prepare('SELECT id, handle, status FROM users WHERE handle = ?').get(to);
        if (!recipient) throw new ApiError(404, 'No member with that handle');
        if (recipient.id === req.user.id) throw new ApiError(400, 'You cannot send to yourself');
        if (recipient.status === 'frozen') throw new ApiError(400, 'Recipient account is frozen');
        if (await balance(req.user.id, currency) < amount) {
          throw new ApiError(400, `Insufficient ${currency} balance`);
        }

        const id = Number((await db.prepare(
          "INSERT INTO transfers (from_user, to_user, chain, to_address, currency, amount, status) VALUES (?,?,'internal',?,?,?,'settled')")
          .run(req.user.id, recipient.id, recipient.handle, currency, amount)).lastInsertRowid);
        const led = db.prepare(
          "INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,?,?,?,'transfer',?,?)");
        await led.run(req.user.id, currency, -amount, 'transfer_out', id, `to @${recipient.handle}`);
        await led.run(recipient.id, currency, amount, 'transfer_in', id, `from @${req.user.handle}`);
        await audit(req.user.id, 'transfer.send', `transfer:${id}`,
          `@${req.user.handle} -> @${recipient.handle} ${amount} ${currency}`);
        return id;
      });

      const row = await db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(tid);
      res.status(201).json({
        transfer: transferOut(row, req.user.id),
        balance: await balance(req.user.id, currency),
      });
    } catch (e) { next(e); }
  });

  app.post('/api/transfers/record', requireAuth, async (req, res, next) => {
    try {
      const chain = oneOf(req.body?.chain, EXTERNAL_CHAINS, 'chain');
      const txid = str(req.body?.txid, { min: 8, max: 130, name: 'txid' });
      if (!TXID_RE.test(txid.replace(/^0x/i, ''))) {
        throw new ApiError(400, 'txid must be 8–128 hex characters');
      }
      const toAddress = str(req.body?.toAddress, { min: 4, max: 128, name: 'toAddress' });
      // On-chain amounts are in native units (BTC/ETH/...), not ledger dollars:
      // no 2dp rounding, and the floor is one satoshi-scale unit, so real
      // client sends (e.g. 0.0005 BTC, 0.018 ETH) are stored exactly.
      const amount = num(req.body?.amount, { min: 1e-8, max: MAX_AMOUNT, name: 'amount' });
      const currency = str(req.body?.currency, { min: 2, max: 10, name: 'currency' }).toUpperCase();
      if (!CURRENCY_RE.test(currency)) throw new ApiError(400, 'currency has an invalid format');

      const tid = await tx(async () => {
        const id = Number((await db.prepare(
          "INSERT INTO transfers (from_user, to_user, chain, to_address, currency, amount, txid, status) VALUES (?,NULL,?,?,?,?,?,'broadcast')")
          .run(req.user.id, chain, toAddress, currency, amount, txid)).lastInsertRowid);
        await audit(req.user.id, 'transfer.record', `transfer:${id}`, `${chain} ${amount} ${currency}`);
        return id;
      });

      const row = await db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(tid);
      res.status(201).json({ transfer: transferOut(row, req.user.id) });
    } catch (e) { next(e); }
  });

  app.get('/api/transfers', requireAuth, async (req, res) => {
    const rows = await db.prepare(
      `${TRANSFER_SELECT} WHERE t.from_user = ? OR t.to_user = ? ORDER BY t.id DESC`)
      .all(req.user.id, req.user.id);
    res.json({ transfers: rows.map((r) => transferOut(r, req.user.id)) });
  });

  // ---- unified activity feed (dashboard) -----------------------------------
  // Recent real ledger movements — deposits, transfers, stakes, dividends,
  // gift cards, goal contributions. Empty for a brand-new account until the
  // member actually does something.
  app.get('/api/activity', requireAuth, async (req, res) => {
    const rows = await db.prepare(
      `SELECT id, currency, delta, kind, memo, created_at
       FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 8`).all(req.user.id);
    res.json({
      activity: rows.map((r) => ({
        id: r.id, kind: r.kind, currency: r.currency,
        delta: round2(r.delta), memo: r.memo, createdAt: r.created_at,
      })),
    });
  });

  // ---- deposits (Add Funds) ------------------------------------------------
  // User-initiated funding of the USDC/OSM ledger. Replaces the old demo
  // "founding balance" grant: an account starts at zero and the member tops it
  // up here (in a production deployment this settles against a real bank/card
  // on-ramp; the ledger entry is honest and audit-logged either way).
  app.post('/api/deposits', requireAuth, async (req, res, next) => {
    try {
      const currency = req.body?.currency === undefined
        ? 'USDC'
        : oneOf(String(req.body.currency).toUpperCase(), ['USDC', 'OSM'], 'currency');
      const amount = round2(num(req.body?.amount, { min: 0.01, max: 250000, name: 'amount' }));
      const method = req.body?.method === undefined
        ? 'bank'
        : oneOf(String(req.body.method).toLowerCase(), ['bank', 'card', 'wire'], 'method');

      const deposit = await tx(async () => {
        const id = Number((await db.prepare(
          "INSERT INTO ledger (user_id, currency, delta, kind, ref_type, memo) VALUES (?,?,?,'deposit','deposit',?)")
          .run(req.user.id, currency, amount, `${method} deposit`)).lastInsertRowid);
        await audit(req.user.id, 'deposit', `ledger:${id}`, `${amount} ${currency} via ${method}`);
        return { id, currency, amount, method };
      });
      res.status(201).json({ deposit, balance: await balance(req.user.id, currency) });
    } catch (e) { next(e); }
  });
}
