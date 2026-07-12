import { db } from '../db.js';
import { requireAuth, round2 } from '../lib/util.js';

// ---- date helpers (UTC, to match sqlite datetime('now')) -------------------

/** 'YYYY-MM' labels for the last n calendar months, oldest first. */
function lastMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      .toISOString().slice(0, 7));
  }
  return out;
}

/** Next calendar quarter-end (YYYY-MM-DD), today inclusive. */
function nextQuarterEnd(from = new Date()) {
  const y = from.getUTCFullYear();
  const today = from.toISOString().slice(0, 10);
  const ends = [`${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`, `${y + 1}-03-31`];
  return ends.find((d) => d >= today);
}

export default function mount(app) {
  app.get('/api/portfolio', requireAuth, (req, res, next) => {
    try {
      const uid = req.user.id;

      const posRows = db.prepare(`
        SELECT v.id AS ventureId, v.name, v.sector, v.apy, SUM(i.amount) AS stake
        FROM investments i JOIN ventures v ON v.id = i.venture_id
        WHERE i.user_id = ? AND i.status = 'active'
        GROUP BY v.id ORDER BY MIN(i.created_at), v.id`).all(uid);

      // Dividends received per venture (from payout records, not ledger, so the
      // attribution to a venture is exact regardless of ledger ref conventions).
      const divRows = db.prepare(`
        SELECT p.venture_id AS ventureId, COALESCE(SUM(pi.amount), 0) AS paid
        FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id
        WHERE pi.user_id = ? AND p.kind = 'dividend'
        GROUP BY p.venture_id`).all(uid);
      const divByVenture = new Map(divRows.map((r) => [r.ventureId, round2(r.paid)]));

      const positions = posRows.map((r) => {
        const stake = round2(r.stake);
        const dividendsPaid = divByVenture.get(r.ventureId) ?? 0;
        const valueNow = round2(stake + dividendsPaid);
        const pl = round2(valueNow - stake);
        return {
          ventureId: r.ventureId,
          name: r.name,
          sector: r.sector,
          stake,
          valueNow,
          pl,
          plPct: stake > 0 ? round2((pl / stake) * 100) : 0,
          apy: r.apy,
          dividendsPaid,
        };
      });

      const deployed = round2(positions.reduce((s, p) => s + p.stake, 0));
      const currentValue = round2(positions.reduce((s, p) => s + p.valueNow, 0));
      const netPl = round2(currentValue - deployed);
      const netPlPct = deployed > 0 ? round2((netPl / deployed) * 100) : 0;

      const allocation = positions.map((p) => ({
        name: p.name,
        pct: deployed > 0 ? round2((p.stake / deployed) * 100) : 0,
      }));

      // 12-month series: deployed capital + cumulative dividends, snapshot at
      // each month end, replayed from ledger history. invest/exit rows move
      // cash <-> deployed (so -delta), dividends add value.
      const monthly = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS ym,
               SUM(CASE WHEN kind IN ('invest','exit') THEN -delta
                        WHEN kind = 'dividend' THEN delta ELSE 0 END) AS v
        FROM ledger WHERE user_id = ? AND currency = 'USDC'
        GROUP BY ym ORDER BY ym`).all(uid);
      let acc = 0;
      let i = 0;
      const series = lastMonths(12).map((month) => {
        while (i < monthly.length && monthly[i].ym <= month) acc += monthly[i++].v;
        return { month, value: round2(acc) };
      });

      // Diversification: distinct sectors held, score = (1 - Herfindahl index)
      // of sector weights scaled to 0–100 (0 = all in one sector).
      const bySector = new Map();
      for (const p of positions) bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + p.stake);
      let hhi = 0;
      if (deployed > 0) for (const w of bySector.values()) hhi += (w / deployed) ** 2;
      const diversification = {
        score: deployed > 0 ? Math.round((1 - hhi) * 100) : 0,
        sectors: bySector.size,
      };

      // Next dividend estimate: one quarter of APY on the soonest (earliest
      // entered) active position, due at the next calendar quarter end.
      let nextDividend = null;
      if (positions.length) {
        const p = positions[0];
        nextDividend = {
          amount: round2((p.stake * p.apy) / 100 / 4),
          date: nextQuarterEnd(),
          venture: p.name,
        };
      }

      res.json({
        deployed, currentValue, netPl, netPlPct, nextDividend,
        positions, allocation, series, diversification,
      });
    } catch (e) { next(e); }
  });

  app.get('/api/reports', requireAuth, (req, res, next) => {
    try {
      const uid = req.user.id;
      const yearStart = `${new Date().getUTCFullYear()}-01-01`;

      // Net worth movement counts every USDC delta except invest/exit, which
      // just move value between cash and deployed stake (net-neutral).
      const ytd = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN kind NOT IN ('invest','exit') THEN delta ELSE 0 END), 0) AS netWorth,
               COALESCE(SUM(CASE WHEN kind = 'dividend' THEN delta ELSE 0 END), 0) AS dividends,
               COALESCE(SUM(CASE WHEN kind = 'fee' AND delta < 0 THEN -delta ELSE 0 END), 0) AS fees,
               COALESCE(SUM(CASE WHEN kind = 'reimbursement' THEN 1 ELSE 0 END), 0) AS receipts
        FROM ledger WHERE user_id = ? AND currency = 'USDC' AND created_at >= ?`)
        .get(uid, yearStart);
      const baseline = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN kind NOT IN ('invest','exit') THEN delta ELSE 0 END), 0) AS b
        FROM ledger WHERE user_id = ? AND currency = 'USDC' AND created_at < ?`)
        .get(uid, yearStart).b;

      const netWorthYtd = round2(ytd.netWorth);
      const netWorthYtdPct = baseline > 0
        ? round2((netWorthYtd / baseline) * 100)
        : (netWorthYtd > 0 ? 100 : 0);

      const dividendLedger = db.prepare(`
        SELECT pi.amount, p.id AS payoutId, p.created_at AS date, v.name AS venture
        FROM payout_items pi
        JOIN payouts p ON p.id = pi.payout_id
        JOIN ventures v ON v.id = p.venture_id
        WHERE pi.user_id = ? AND p.kind = 'dividend'
        ORDER BY p.created_at DESC, p.id DESC`).all(uid)
        .map((r) => {
          const mm = Number(r.date.slice(5, 7));
          return {
            venture: r.venture,
            quarter: `Q${Math.floor((mm - 1) / 3) + 1} ${r.date.slice(0, 4)}`,
            amount: round2(r.amount),
            status: 'paid',
            date: r.date,
            txref: `OSM-PO-${String(r.payoutId).padStart(4, '0')}`,
          };
        });

      const statements = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS txCount
        FROM ledger WHERE user_id = ?
        GROUP BY month ORDER BY month DESC`).all(uid)
        .map((r) => ({
          month: r.month,
          txCount: Number(r.txCount),
          sizeMb: round2(0.03 + Number(r.txCount) * 0.012),
        }));

      res.json({
        netWorthYtd,
        netWorthYtdPct,
        dividendsYtd: round2(ytd.dividends),
        feesYtd: round2(ytd.fees),
        receiptsFiled: Number(ytd.receipts),
        dividendLedger,
        statements,
      });
    } catch (e) { next(e); }
  });

  app.get('/api/reports/export', requireAuth, (req, res, next) => {
    try {
      const rows = db.prepare(`
        SELECT id, created_at, currency, kind, delta, ref_type, ref_id, memo
        FROM ledger WHERE user_id = ?
        ORDER BY created_at DESC, id DESC`).all(req.user.id);

      const cell = (v) => {
        if (v === null || v === undefined) return '';
        let s = String(v);
        // Spreadsheet formula guard for text fields (never for our numbers).
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const lines = ['id,date,currency,kind,amount,refType,refId,memo'];
      for (const r of rows) {
        lines.push([r.id, r.created_at, r.currency, r.kind, r.delta, r.ref_type, r.ref_id, r.memo]
          .map(cell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="osmobank-ledger.csv"');
      res.send(lines.join('\r\n') + '\r\n');
    } catch (e) { next(e); }
  });
}
