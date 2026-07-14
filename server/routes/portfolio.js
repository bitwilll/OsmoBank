import { db } from '../db.js';
import { requireAuth, round2 } from '../lib/util.js';
import { Pdf } from '../lib/pdf.js';

const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedUsd = (n) => (Number(n) >= 0 ? '+' : '') + usd(n);
// The member number IS the account id — no vanity offset inflating the roster.
const memberNo = (id) => Number(id);

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

/** YTD report aggregates for a user (shared by GET /api/reports and PDF export). */
async function computeReport(uid) {
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const ytd = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind NOT IN ('invest','exit') THEN delta ELSE 0 END), 0) AS netWorth,
           COALESCE(SUM(CASE WHEN kind = 'dividend' THEN delta ELSE 0 END), 0) AS dividends,
           COALESCE(SUM(CASE WHEN kind = 'fee' AND delta < 0 THEN -delta ELSE 0 END), 0) AS fees,
           COALESCE(SUM(CASE WHEN kind = 'reimbursement' THEN 1 ELSE 0 END), 0) AS receipts
    FROM ledger WHERE user_id = ? AND currency = 'USDC' AND created_at >= ?`).get(uid, yearStart);
  const baseline = (await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind NOT IN ('invest','exit') THEN delta ELSE 0 END), 0) AS b
    FROM ledger WHERE user_id = ? AND currency = 'USDC' AND created_at < ?`).get(uid, yearStart)).b;
  const netWorthYtd = round2(ytd.netWorth);
  // Without a prior-year baseline there is no honest percentage — return null
  // and let clients render '—' instead of a degenerate "+100%".
  const netWorthYtdPct = baseline > 0 ? round2((netWorthYtd / baseline) * 100) : null;
  const dividendLedger = (await db.prepare(`
    SELECT pi.amount, p.id AS payoutId, p.created_at AS date, v.name AS venture
    FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id JOIN ventures v ON v.id = p.venture_id
    WHERE pi.user_id = ? AND p.kind = 'dividend' ORDER BY p.created_at DESC, p.id DESC`).all(uid))
    .map((r) => {
      const mm = Number(r.date.slice(5, 7));
      return { venture: r.venture, quarter: `Q${Math.floor((mm - 1) / 3) + 1} ${r.date.slice(0, 4)}`,
        amount: round2(r.amount), status: 'paid', date: r.date, txref: `OSM-PO-${String(r.payoutId).padStart(4, '0')}` };
    });
  const statements = (await db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS txCount
    FROM ledger WHERE user_id = ? GROUP BY month ORDER BY month DESC`).all(uid))
    .map((r) => ({ month: r.month, txCount: Number(r.txCount) })); // no invented file sizes
  return { netWorthYtd, netWorthYtdPct, dividendsYtd: round2(ytd.dividends), feesYtd: round2(ytd.fees),
    receiptsFiled: Number(ytd.receipts), dividendLedger, statements };
}

/** Per-venture positions for a user (shared by GET /api/portfolio and edge export). */
async function computePositions(uid) {
  return Promise.all((await db.prepare(`
    SELECT v.id, v.name, v.sector, v.apy, SUM(i.amount) AS stake
    FROM investments i JOIN ventures v ON v.id = i.venture_id
    WHERE i.user_id = ? AND i.status = 'active' GROUP BY v.id ORDER BY stake DESC`).all(uid))
    .map(async (r) => {
      const div = (await db.prepare(`SELECT COALESCE(SUM(pi.amount),0) AS d FROM payout_items pi
        JOIN payouts p ON p.id = pi.payout_id WHERE pi.user_id = ? AND p.venture_id = ? AND p.kind = 'dividend'`)
        .get(uid, r.id)).d;
      const stake = round2(r.stake);
      const valueNow = round2(stake + div);
      return { name: r.name, sector: r.sector, apy: r.apy, stake, dividendsPaid: round2(div),
        valueNow, pl: round2(valueNow - stake), plPct: stake > 0 ? round2((valueNow - stake) / stake * 100) : 0 };
    }));
}

export default function mount(app) {
  app.get('/api/portfolio', requireAuth, async (req, res, next) => {
    try {
      const uid = req.user.id;

      const posRows = await db.prepare(`
        SELECT v.id AS ventureId, v.name, v.sector, v.apy, SUM(i.amount) AS stake
        FROM investments i JOIN ventures v ON v.id = i.venture_id
        WHERE i.user_id = ? AND i.status = 'active'
        GROUP BY v.id ORDER BY MIN(i.created_at), v.id`).all(uid);

      // Dividends received per venture (from payout records, not ledger, so the
      // attribution to a venture is exact regardless of ledger ref conventions).
      const divRows = await db.prepare(`
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
      const monthly = await db.prepare(`
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

  app.get('/api/reports', requireAuth, async (req, res, next) => {
    try { res.json(await computeReport(req.user.id)); } catch (e) { next(e); }
  });

  // Spreadsheet formula-injection guard for CSV text fields.
  const csvCell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sendCsv = (res, name, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  };
  const sendPdf = (res, name, buf) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    res.send(buf);
  };
  const stamp = (u) => `${u.name} · @${u.handle} · Member #${memberNo(u.id)}`;

  // Account statement — CSV (raw ledger) or PDF (formatted).  ?format=csv|pdf
  app.get('/api/reports/export', requireAuth, async (req, res, next) => {
    try {
      const uid = req.user.id;
      const format = (req.query.format || 'csv').toLowerCase();

      if (format === 'pdf') {
        const rep = await computeReport(uid);
        const pdf = new Pdf({ title: 'OsmoBank — Account Statement' });
        pdf.text(stamp(req.user), { gray: 0.4 });
        pdf.text(`Generated ${new Date().toISOString().slice(0, 10)} · ${req.user.role.toUpperCase()}`, { size: 8, gray: 0.5 });
        pdf.heading('YEAR TO DATE');
        pdf.row('Net worth', rep.netWorthYtdPct == null
          ? signedUsd(rep.netWorthYtd)
          : `${signedUsd(rep.netWorthYtd)} (${rep.netWorthYtdPct >= 0 ? '+' : ''}${rep.netWorthYtdPct}%)`);
        pdf.row('Dividends', usd(rep.dividendsYtd));
        pdf.row('Fees paid', usd(rep.feesYtd));
        pdf.row('Receipts filed', String(rep.receiptsFiled));
        pdf.heading('DIVIDEND LEDGER');
        if (rep.dividendLedger.length) {
          pdf.table(
            [{ label: 'VENTURE', width: 0.34 }, { label: 'QUARTER', width: 0.18 },
              { label: 'DATE', width: 0.18 }, { label: 'TX REF', width: 0.18 }, { label: 'AMOUNT', width: 0.12, align: 'right' }],
            rep.dividendLedger.map((d) => [d.venture, d.quarter, d.date.slice(0, 10), d.txref, signedUsd(d.amount)]));
        } else pdf.text('No dividends recorded yet.', { gray: 0.5 });
        pdf.heading('MONTHLY STATEMENTS');
        pdf.table([{ label: 'MONTH', width: 0.6 }, { label: 'TX', width: 0.4, align: 'right' }],
          rep.statements.map((s) => [s.month, String(s.txCount)]));
        return sendPdf(res, 'osmobank-statement', pdf.build());
      }

      const rows = await db.prepare(`
        SELECT id, created_at, currency, kind, delta, ref_type, ref_id, memo
        FROM ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(uid);
      sendCsv(res, 'osmobank-ledger',
        [['id', 'date', 'currency', 'kind', 'amount', 'refType', 'refId', 'memo'],
          ...rows.map((r) => [r.id, r.created_at, r.currency, r.kind, r.delta, r.ref_type, r.ref_id, r.memo])]);
    } catch (e) { next(e); }
  });

  // Investor's Edge report — positions/P&L.  ?format=csv|pdf
  app.get('/api/portfolio/export', requireAuth, async (req, res, next) => {
    try {
      const positions = await computePositions(req.user.id);
      const deployed = round2(positions.reduce((s, p) => s + p.stake, 0));
      const currentValue = round2(positions.reduce((s, p) => s + p.valueNow, 0));
      const format = (req.query.format || 'csv').toLowerCase();

      if (format === 'pdf') {
        const pdf = new Pdf({ title: "OsmoBank — Investor's Edge" });
        pdf.text(stamp(req.user), { gray: 0.4 });
        pdf.text(`Generated ${new Date().toISOString().slice(0, 10)}`, { size: 8, gray: 0.5 });
        pdf.heading('SUMMARY');
        pdf.row('Deployed', usd(deployed));
        pdf.row('Current value', usd(currentValue));
        pdf.row('Net P/L', `${signedUsd(round2(currentValue - deployed))}`);
        pdf.heading('POSITIONS');
        if (positions.length) {
          pdf.table(
            [{ label: 'VENTURE', width: 0.3 }, { label: 'SECTOR', width: 0.16 }, { label: 'STAKE', width: 0.15, align: 'right' },
              { label: 'VALUE', width: 0.15, align: 'right' }, { label: 'P/L', width: 0.14, align: 'right' }, { label: 'APY', width: 0.1, align: 'right' }],
            positions.map((p) => [p.name, p.sector, usd(p.stake), usd(p.valueNow), signedUsd(p.pl), `${p.apy}%`]));
        } else pdf.text('No positions yet.', { gray: 0.5 });
        return sendPdf(res, 'osmobank-edge', pdf.build());
      }

      sendCsv(res, 'osmobank-edge',
        [['venture', 'sector', 'stake', 'valueNow', 'pl', 'plPct', 'apy', 'dividendsPaid'],
          ...positions.map((p) => [p.name, p.sector, p.stake, p.valueNow, p.pl, p.plPct, p.apy, p.dividendsPaid])]);
    } catch (e) { next(e); }
  });

}
