/* User payment cards + gift-card store.
 * Cards are demo virtual cards (generated PAN/CVV/expiry) a member can issue,
 * freeze, set a daily limit on, rename, and reveal (passphrase-gated). The
 * gift-card store debits the real USDC ledger. */
import { randomInt } from 'node:crypto';
import { db, tx, balance, audit } from '../db.js';
import { ApiError, str, num, oneOf, round2, requireAuth, verifyPass, assertNotLocked, recordFail, clearFails } from '../lib/util.js';

const BINS = { OSMO: '473501', VISA: '400000', MC: '520000' };

function luhnComplete(partial) {
  // append the Luhn check digit that makes `partial` (as the leading digits) valid
  let sum = 0, alt = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = partial.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  const check = (10 - (sum % 10)) % 10;
  return partial + String(check);
}

function newPan(brand) {
  const bin = BINS[brand] || BINS.OSMO;
  let body = bin;
  while (body.length < 15) body += String(randomInt(0, 10));
  return luhnComplete(body.slice(0, 15));
}

/** Issue a card for a user. Exported so registration can grant a default one. */
export function issueCard(userId, { label = 'OsmoCard', brand = 'OSMO', kind = 'virtual', dailyLimit = 2000 } = {}) {
  const pan = newPan(brand);
  const now = new Date();
  const expMonth = now.getUTCMonth() + 1;
  const expYear = now.getUTCFullYear() + 4;
  const cvv = String(randomInt(0, 1000)).padStart(3, '0');
  const id = Number(db.prepare(
    `INSERT INTO cards (user_id, label, brand, pan, last4, exp_month, exp_year, cvv, kind, daily_limit)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, label, brand, pan, pan.slice(-4), expMonth, expYear, cvv, kind, dailyLimit).lastInsertRowid);
  return id;
}

const cardOut = (c) => ({
  id: c.id, label: c.label, brand: c.brand, last4: c.last4,
  exp: `${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}`,
  kind: c.kind, frozen: !!c.frozen, dailyLimit: c.daily_limit, createdAt: c.created_at,
});

function ownCard(req) {
  const id = num(req.params.id, { min: 1, int: true, name: 'id' });
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!c) throw new ApiError(404, 'Card not found');
  if (c.user_id !== req.user.id) throw new ApiError(403, 'Not your card');
  return c;
}

// Month-to-date card spend from outgoing internal transfers (a demo proxy).
function monthSpend(userId) {
  const ym = new Date().toISOString().slice(0, 7);
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transfers
     WHERE from_user = ? AND currency = 'USDC' AND strftime('%Y-%m', created_at) = ?`).get(userId, ym);
  return round2(row.s);
}

const GIFT_BRANDS = {
  'AURORA AIR': { back: 3 }, 'SOLACE COFFEE': { back: 2 },
  'CITY TRANSIT': { back: 5 }, PLAYFIELD: { back: 2 },
};

export default function mount(app) {
  app.get('/api/cards', requireAuth, (req, res) => {
    const cards = db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id ASC').all(req.user.id).map(cardOut);
    const spend = monthSpend(req.user.id);
    res.json({
      cards, spend,
      spendBreakdown: { groceries: round2(spend * 0.4), transit: round2(spend * 0.25), dining: round2(spend * 0.35) },
    });
  });

  app.post('/api/cards', requireAuth, (req, res, next) => {
    try {
      const label = req.body?.label ? str(req.body.label, { min: 1, max: 40, name: 'label' }) : 'OsmoCard';
      const brand = req.body?.brand ? oneOf(String(req.body.brand).toUpperCase(), ['OSMO', 'VISA', 'MC'], 'brand') : 'OSMO';
      const kind = req.body?.kind ? oneOf(String(req.body.kind), ['virtual', 'physical'], 'kind') : 'virtual';
      if (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE user_id = ?').get(req.user.id).n >= 8) {
        throw new ApiError(409, 'Card limit reached (8)');
      }
      const id = issueCard(req.user.id, { label, brand, kind });
      audit(req.user.id, 'card.issue', `card:${id}`, `${brand} ${kind}`);
      res.status(201).json({ card: cardOut(db.prepare('SELECT * FROM cards WHERE id = ?').get(id)) });
    } catch (e) { next(e); }
  });

  app.patch('/api/cards/:id', requireAuth, (req, res, next) => {
    try {
      const c = ownCard(req);
      const sets = [], vals = [];
      if (req.body?.frozen !== undefined) { sets.push('frozen = ?'); vals.push(req.body.frozen ? 1 : 0); }
      if (req.body?.label !== undefined) { sets.push('label = ?'); vals.push(str(req.body.label, { min: 1, max: 40, name: 'label' })); }
      if (req.body?.dailyLimit !== undefined) { sets.push('daily_limit = ?'); vals.push(num(req.body.dailyLimit, { min: 0, max: 1e6, name: 'dailyLimit' })); }
      if (!sets.length) throw new ApiError(400, 'nothing to update');
      db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, c.id);
      audit(req.user.id, 'card.update', `card:${c.id}`, sets.join(','));
      res.json({ card: cardOut(db.prepare('SELECT * FROM cards WHERE id = ?').get(c.id)) });
    } catch (e) { next(e); }
  });

  // Reveal full PAN + CVV — passphrase-gated, audit-logged.
  app.post('/api/cards/:id/reveal', requireAuth, (req, res, next) => {
    try {
      const c = ownCard(req);
      const lockKey = `reveal:${req.user.id}`;
      assertNotLocked(lockKey);
      const pass = str(req.body?.passphrase, { min: 1, max: 200, name: 'passphrase' });
      if (!verifyPass(pass, req.user.pass)) { recordFail(lockKey); throw new ApiError(401, 'Wrong passphrase'); }
      clearFails(lockKey);
      audit(req.user.id, 'card.reveal', `card:${c.id}`);
      res.json({
        pan: c.pan.replace(/(.{4})/g, '$1 ').trim(), cvv: c.cvv,
        exp: `${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}`,
      });
    } catch (e) { next(e); }
  });

  app.delete('/api/cards/:id', requireAuth, (req, res, next) => {
    try {
      const c = ownCard(req);
      db.prepare('DELETE FROM cards WHERE id = ?').run(c.id);
      audit(req.user.id, 'card.remove', `card:${c.id}`);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- gift-card store -----------------------------------------------------
  app.post('/api/cards/gift', requireAuth, (req, res, next) => {
    try {
      const brand = oneOf(String(req.body?.brand || '').toUpperCase(), Object.keys(GIFT_BRANDS), 'brand');
      const amount = round2(num(req.body?.amount, { min: 1, max: 5000, name: 'amount' }));
      const out = tx(() => {
        if (balance(req.user.id, 'USDC') < amount) throw new ApiError(400, 'Insufficient USDC balance');
        db.prepare("INSERT INTO ledger (user_id, currency, delta, kind, ref_type, memo) VALUES (?,?,?,'giftcard','card',?)")
          .run(req.user.id, 'USDC', -amount, `${brand} gift card`);
        const code = `${brand.slice(0, 3)}-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}`;
        const id = Number(db.prepare('INSERT INTO gift_cards (user_id, brand, amount, code) VALUES (?,?,?,?)')
          .run(req.user.id, brand, amount, code).lastInsertRowid);
        audit(req.user.id, 'giftcard.buy', `gift:${id}`, `${brand} $${amount}`);
        return { id, brand, amount, code, back: GIFT_BRANDS[brand].back };
      });
      res.status(201).json({ gift: out, balance: balance(req.user.id, 'USDC') });
    } catch (e) { next(e); }
  });

  app.get('/api/cards/gifts', requireAuth, (req, res) => {
    const gifts = db.prepare('SELECT id, brand, amount, code, created_at FROM gift_cards WHERE user_id = ? ORDER BY id DESC').all(req.user.id)
      .map((g) => ({ id: g.id, brand: g.brand, amount: g.amount, code: g.code, createdAt: g.created_at }));
    res.json({ gifts });
  });
}
