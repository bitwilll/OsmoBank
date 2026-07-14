/* Reports screen hydrator — GET /api/reports (+ /api/portfolio for the
 * next-dividend estimate row). All API data lands via textContent. */

const GRN = 'var(--grn,#17a562)';
const AMBER = 'var(--red,#c47b10)';
const AMBER_BORDER = 'var(--reds,#f0b9b5)';
const GRN_BORDER = 'color-mix(in srgb,var(--grn,#17a562) 35%,transparent)';

// ---- design-styled element helpers (mirrors app.js modal conventions) -------
const mk = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const modalDescCss = "font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--mut,#757575);letter-spacing:.06em;margin:2px 0 4px";
const pillBaseCss = "display:flex;align-items:center;justify-content:center;gap:9px;padding:13px 0;border-radius:100px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px";
const pillSolidCss = pillBaseCss + ';background:var(--ink,#0a0a0a);color:var(--inv,#fff)';
const pillGhostCss = pillBaseCss + ';border:1px solid var(--dt,#d9d9d9);color:var(--ink,#0a0a0a)';
const pillIconCss = "font-family:'Material Symbols Sharp';font-size:18px;line-height:1";

/** CSV/PDF export chooser for the account statement. */
function openExportChooser(ctx) {
  const m = ctx.buildModal('EXPORT STATEMENT', 'download');
  m.body.appendChild(mk('div', modalDescCss, 'LEDGER · DIVIDENDS · FEES · CHOOSE A FORMAT'));

  const makeBtn = (format, icon, label, css) => {
    const b = mk('div', css);
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.append(mk('span', pillIconCss, icon), document.createTextNode(label));
    const go = () => {
      window.open(`/api/reports/export?format=${format}`);
      ctx.toast(`STATEMENT EXPORTED · ${format.toUpperCase()}`);
      m.close();
    };
    b.addEventListener('click', go);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
    return b;
  };

  m.body.appendChild(makeBtn('csv', 'table_view', 'Download CSV', pillSolidCss));
  m.body.appendChild(makeBtn('pdf', 'picture_as_pdf', 'Download PDF', pillGhostCss));
}

/** sqlite dates come as 'YYYY-MM-DD[ HH:MM:SS]'; fmt.date needs a time part. */
const isoish = (d) => {
  const s = String(d ?? '');
  return s.includes(' ') || s.includes('T') ? s : s + ' 00:00:00';
};

/** 'YYYY-MM-DD' -> 'Q3' */
const quarterOf = (d) => {
  const m = Number(String(d ?? '').slice(5, 7));
  return m >= 1 ? `Q${Math.floor((m - 1) / 3) + 1}` : '';
};

/** 'YYYY-MM' -> 'June 2026' (UTC so the month never shifts locally). */
const monthName = (ym) => {
  const [y, m] = String(ym ?? '').split('-').map(Number);
  if (!y || !m) return String(ym ?? '');
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export async function hydrate(root, ctx) {
  const { api, fmt, slot, list, toast, errToast, setAction } = ctx;

  if (!root.dataset.hydrated) {
    setAction('addReceipt', () => toast('RECEIPT SNAPPED · MATCHED TO CARD SPEND · DEMO'));
    // "Export CSV / PDF" now opens a format chooser instead of a direct CSV download.
    setAction('demoExport', () => openExportChooser(ctx));
    // per-month statement download icons stream the PDF statement directly.
    setAction('exportPdf', () => window.open('/api/reports/export?format=pdf'));
    root.dataset.hydrated = '1';
  }

  let rep, port;
  try {
    [rep, port] = await Promise.all([
      api.get('/api/reports'),
      api.get('/api/portfolio').catch(() => null), // estimate row is optional
    ]);
  } catch (e) { errToast(e); return; }

  // ---- stat cards -----------------------------------------------------------
  const nw = Number(rep.netWorthYtd ?? 0);
  const nwEl = slot(root, 'reports.netWorth');
  nwEl.textContent = fmt.signedUsd(nw);
  nwEl.style.color = nw >= 0 ? GRN : AMBER;
  const pct = Number(rep.netWorthYtdPct ?? 0);
  slot(root, 'reports.netWorthSub').textContent =
    `${pct >= 0 ? '+' : '−'}${fmt.pct(Math.abs(pct))} SINCE JAN 01`;

  const paid = (rep.dividendLedger || []).filter((d) => d.status === 'paid');
  slot(root, 'reports.dividends').textContent = fmt.usd(rep.dividendsYtd);
  const ventureCount = new Set(paid.map((d) => d.venture)).size;
  slot(root, 'reports.dividendsSub').textContent =
    `ACROSS ${fmt.num(ventureCount)} VENTURES · ${fmt.num(paid.length)} PAYOUTS`;

  slot(root, 'reports.fees').textContent = fmt.usd2(rep.feesYtd);
  slot(root, 'reports.receipts').textContent = fmt.num(rep.receiptsFiled);
  slot(root, 'reports.vaultCount').textContent = fmt.num(rep.receiptsFiled);

  // ---- dividend ledger ------------------------------------------------------
  const led = list(root, 'reports.dividendLedger');
  led.clear();
  const addDivRow = (o) => {
    const row = led.add();
    slot(row, 't').textContent = o.title;
    slot(row, 'sub').textContent = o.sub;
    const amt = slot(row, 'amt');
    amt.textContent = o.amt;
    amt.style.color = o.amtColor;
    const chip = slot(row, 'chip');
    chip.textContent = o.chip;
    chip.style.display = o.chip ? '' : 'none';
    chip.style.color = o.chipColor || '';
    chip.style.borderColor = o.chipBorder || '';
    return row;
  };

  const nd = port?.nextDividend;
  if (nd) {
    addDivRow({
      title: `${nd.venture} · ${quarterOf(nd.date)}`,
      sub: `${fmt.date(isoish(nd.date))} · ESTIMATED`,
      amt: fmt.usd2(nd.amount),
      amtColor: 'var(--ink,#0a0a0a)',
      chip: 'UPCOMING', chipColor: AMBER, chipBorder: AMBER_BORDER,
    });
  }
  for (const d of paid) {
    addDivRow({
      title: `${d.venture} · ${d.quarter}`,
      sub: `${fmt.date(isoish(d.date))} · TX ${d.txref}`,
      amt: '+' + fmt.usd2(d.amount),
      amtColor: GRN,
      chip: 'PAID', chipColor: GRN, chipBorder: GRN_BORDER,
    });
  }
  if (!nd && !paid.length) {
    addDivRow({
      title: 'No dividends yet',
      sub: 'STAKE IN A VENTURE TO START EARNING',
      amt: '', amtColor: '', chip: '',
    });
  }

  // ---- monthly statements ---------------------------------------------------
  const st = list(root, 'reports.statements');
  st.clear();
  for (const s of rep.statements || []) {
    const row = st.add();
    slot(row, 'm').textContent = monthName(s.month);
    slot(row, 'meta').textContent =
      `${fmt.num(s.txCount)} TX · ${Number(s.sizeMb ?? 0).toFixed(1)} MB`;
    // the cloned download icon keeps data-action="exportPdf"
    // (screen action: window.open('/api/reports/export?format=pdf'))
  }
  if (!(rep.statements || []).length) {
    const row = st.add();
    slot(row, 'm').textContent = 'No statements yet';
    slot(row, 'meta').textContent = '0 TX';
    // Nothing to download in the empty state — hide the per-row PDF icon.
    const dl = row.querySelector('[data-action="exportPdf"]');
    if (dl) dl.style.display = 'none';
  }
}
