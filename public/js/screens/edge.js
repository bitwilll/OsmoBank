/* Investor's Edge: live portfolio analytics from GET /api/portfolio.
 * Export button streams the caller's ledger CSV from /api/reports/export. */

const PALETTE = ['#c47b10', '#4098d7', '#8a8a8a', '#2fae7d', '#8752f3'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const GRN = 'var(--grn,#17a562)';
const RED = 'var(--red,#c47b10)';
const FNT = 'var(--fnt,#a3a3a3)';

const SECTOR_ICONS = [
  [/solar|energy|power|grid/i, 'solar_power'],
  [/robot|manufactur|industr/i, 'precision_manufacturing'],
  [/logist|ship|port|transport|freight/i, 'local_shipping'],
  [/ocean|marine|aqua|water|reef|kelp/i, 'waves'],
  [/mesh|network|telecom|connect|internet/i, 'hub'],
  [/agri|farm|food/i, 'agriculture'],
  [/health|med|bio/i, 'medical_services'],
  [/estate|housing|property/i, 'apartment'],
  [/fin|credit|bank/i, 'account_balance'],
];
const iconFor = (sector) =>
  (SECTOR_ICONS.find(([re]) => re.test(String(sector || ''))) || [null, 'workspaces'])[1];

const put = (el, text, color) => {
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
};
const plColor = (v) => (v >= 0 ? GRN : RED);
const sign = (v) => (v >= 0 ? '+' : '−');

/** $21.8K-style compact dollars (matches the design's headline format). */
function kfmt(fmt, v) {
  const n = Number(v ?? 0);
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return fmt.usd(n);
}

/** "2025-07" → "JUL '25" / "OCT" / "JAN '26" per the design's label rhythm. */
function monthLabel(raw, { withYear = false, monthOnly = false } = {}) {
  const m = /^(\d{4})-(\d{2})/.exec(String(raw ?? ''));
  if (!m) return String(raw ?? '').toUpperCase().slice(0, 8);
  const name = MONTHS[Number(m[2]) - 1] || '—';
  if (monthOnly) return name;
  if (withYear || m[2] === '01') return `${name} '${m[1].slice(2)}`;
  return name;
}

export async function hydrate(root, ctx) {
  const { fmt } = ctx;

  if (!root.dataset.hydrated) {
    root.dataset.hydrated = '1';
    ctx.setAction('demoExport', () => {
      window.open('/api/reports/export', '_blank');
      ctx.toast('EDGE REPORT EXPORTED · CSV');
    });
  }

  let p;
  try {
    p = await ctx.api.get('/api/portfolio');
  } catch (e) {
    ctx.errToast(e);
    return;
  }

  const positions = p.positions || [];
  const allocation = p.allocation || [];
  const series = (p.series || []).slice(-12);
  const last = series.length ? Number(series[series.length - 1].value) || 0 : 0;
  const netPl = Number(p.netPl) || 0;

  // ---- stat cards ----------------------------------------------------------
  put(ctx.slot(root, 'edge.deployed'), fmt.usd(p.deployed));
  put(ctx.slot(root, 'edge.deployedNote'),
    `ACROSS ${positions.length} VENTURE${positions.length === 1 ? '' : 'S'}`);

  put(ctx.slot(root, 'edge.currentValue'), fmt.usd(p.currentValue));
  put(ctx.slot(root, 'edge.markedAt'),
    `MARKED ${fmt.date(new Date().toISOString())} · 06:00 UTC`);

  const prev = series.length > 1 ? Number(series[series.length - 2].value) || 0 : last;
  const monthDelta = last - prev;
  put(ctx.slot(root, 'edge.netPl'), fmt.signedUsd(netPl), plColor(netPl));
  put(ctx.slot(root, 'edge.netPlNote'),
    `${sign(netPl)}${fmt.pct(Math.abs(Number(p.netPlPct) || 0))} ALL-TIME · ` +
    `${monthDelta >= 0 ? '▲' : '▼'} ${fmt.usd(Math.abs(monthDelta))} THIS MONTH`,
    plColor(netPl));

  const nd = p.nextDividend;
  if (nd) {
    const [dollars, cents] = (Number(nd.amount) || 0).toFixed(2).split('.');
    put(ctx.slot(root, 'edge.nextDivMain'), '$' + Number(dollars).toLocaleString('en-US'));
    put(ctx.slot(root, 'edge.nextDivCents'), '.' + cents);
    put(ctx.slot(root, 'edge.nextDivNote'),
      `${fmt.date(nd.date)} · ${String(nd.venture || '').toUpperCase()}`);
  } else {
    put(ctx.slot(root, 'edge.nextDivMain'), '—');
    put(ctx.slot(root, 'edge.nextDivCents'), '');
    put(ctx.slot(root, 'edge.nextDivNote'), 'NO PAYOUT SCHEDULED');
  }

  // ---- portfolio value panel ------------------------------------------------
  put(ctx.slot(root, 'edge.pvHeadline'), kfmt(fmt, p.currentValue));
  const first = series.length ? Number(series[0].value) || 0 : 0;
  const growPct = first > 0 ? ((last - first) / first) * 100 : 0;
  put(ctx.slot(root, 'edge.pvFrom'),
    `FROM ${kfmt(fmt, first)} · ${sign(growPct)}${fmt.pct(Math.abs(growPct), 0)}`,
    plColor(growPct));

  const bars = ctx.list(root, 'edge.bars');
  if (bars) {
    bars.clear();
    const maxValue = Math.max(0, ...series.map((s) => Number(s.value) || 0));
    series.forEach((s, i) => {
      const bar = bars.add();
      const hpct = maxValue > 0 ? Math.max(4, ((Number(s.value) || 0) / maxValue) * 100) : 4;
      bar.style.height = hpct.toFixed(1) + '%';
      bar.style.animationDelay = (0.02 + i * 0.05).toFixed(2) + 's';
      bar.style.background = i === series.length - 1 ? RED : 'var(--ink,#0a0a0a)';
    });
  }

  if (series.length) {
    const at = (i) => series[Math.min(i, series.length - 1)].month;
    put(ctx.slot(root, 'edge.m0'), monthLabel(at(0), { withYear: true }));
    put(ctx.slot(root, 'edge.m3'), monthLabel(at(3)));
    put(ctx.slot(root, 'edge.m6'), monthLabel(at(6)));
    put(ctx.slot(root, 'edge.m9'), monthLabel(at(9)));
    put(ctx.slot(root, 'edge.mNow'), monthLabel(at(series.length - 1), { monthOnly: true }));
  }

  // ---- allocation donut + legend ---------------------------------------------
  const colorByName = {};
  allocation.forEach((a, i) => { colorByName[a.name] = PALETTE[i % PALETTE.length]; });

  const donut = ctx.slot(root, 'edge.donut');
  if (donut) {
    if (allocation.length) {
      // Built purely from our own numeric pcts + fixed palette — safe as a style string.
      let acc = 0;
      const stops = allocation.map((a, i) => {
        const from = acc;
        acc = Math.min(100, acc + (Number(a.pct) || 0));
        return `${PALETTE[i % PALETTE.length]} ${from.toFixed(2)}% ${acc.toFixed(2)}%`;
      });
      if (acc < 99.9) stops.push(`var(--hr,#e4e4e4) ${acc.toFixed(2)}% 100%`);
      donut.style.background = `conic-gradient(${stops.join(', ')})`;
    } else {
      donut.style.background = 'conic-gradient(var(--hr,#e4e4e4) 0 100%)';
    }
  }
  put(ctx.slot(root, 'edge.posCount'), String(positions.length));

  const legend = ctx.list(root, 'edge.legend');
  if (legend) {
    legend.clear();
    if (allocation.length) {
      allocation.forEach((a, i) => {
        const row = legend.add();
        const sw = row.querySelector('[data-slot="edge.legSwatch"]');
        if (sw) sw.style.background = PALETTE[i % PALETTE.length];
        put(row.querySelector('[data-slot="edge.legName"]'), String(a.name || '').toUpperCase());
        put(row.querySelector('[data-slot="edge.legPct"]'), fmt.pct(a.pct, 0));
      });
    } else {
      const row = legend.add();
      const sw = row.querySelector('[data-slot="edge.legSwatch"]');
      if (sw) sw.style.background = 'var(--dt2,#c6c6c6)';
      put(row.querySelector('[data-slot="edge.legName"]'), 'NO POSITIONS YET');
      put(row.querySelector('[data-slot="edge.legPct"]'), '—');
    }
  }

  const dv = p.diversification || {};
  const sectors = Number(dv.sectors) || 0;
  put(ctx.slot(root, 'edge.diversification'),
    `DIVERSIFICATION SCORE: ${String(dv.score ?? '—').toUpperCase()} · ${sectors} SECTOR${sectors === 1 ? '' : 'S'}`);

  // ---- P/L by position table ---------------------------------------------------
  const table = ctx.list(root, 'edge.positions');
  if (table) {
    table.clear();
    if (positions.length) {
      positions.forEach((pos, i) => {
        const row = table.add();
        const icon = row.querySelector('[data-slot="edge.posIcon"]');
        if (icon) {
          icon.textContent = iconFor(pos.sector);
          icon.style.color = colorByName[pos.name] || PALETTE[i % PALETTE.length];
        }
        put(row.querySelector('[data-slot="edge.posName"]'), pos.name || '');
        put(row.querySelector('[data-slot="edge.posStake"]'), fmt.usd(pos.stake));
        put(row.querySelector('[data-slot="edge.posValue"]'), fmt.usd(pos.valueNow));
        const pl = Number(pos.pl) || 0;
        const plPct = Number(pos.plPct) || 0;
        put(row.querySelector('[data-slot="edge.posPl"]'),
          `${fmt.signedUsd(pl)} · ${sign(plPct)}${fmt.pct(Math.abs(plPct))}`, plColor(pl));
        put(row.querySelector('[data-slot="edge.posApy"]'), fmt.pct(pos.apy));
        const paid = Number(pos.dividendsPaid) || 0;
        put(row.querySelector('[data-slot="edge.posDivs"]'),
          paid > 0 ? fmt.usd2(paid) : '—', paid > 0 ? GRN : FNT);
      });
    } else {
      const row = table.add();
      const icon = row.querySelector('[data-slot="edge.posIcon"]');
      if (icon) { icon.textContent = 'workspaces'; icon.style.color = FNT; }
      put(row.querySelector('[data-slot="edge.posName"]'), 'No positions yet — stake from Ventures');
      for (const s of ['posStake', 'posValue', 'posPl', 'posApy', 'posDivs']) {
        put(row.querySelector(`[data-slot="edge.${s}"]`), '—', FNT);
      }
    }
  }
}
