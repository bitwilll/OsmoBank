/* Fundraiser screen: GET /api/fundraiser + POST /api/fundraiser/contribute.
 * Public screen — anonymous visitors see the neutral markup placeholders (the
 * API is auth-gated); the Back CTA routes them to login. A 404 (no open raise)
 * swaps the whole page for an honest empty state. All API data lands via
 * textContent only. */

const S = {
  amount: 500,               // selected contribution (design default chip)
  ventureName: 'this raise', // last known venture name, used in the CTA label
  min: 100,
  activeChip: '500',
};

const UOF_COLORS = ['#1fb597', '#2775ca', 'var(--red,#c47b10)'];

// Design's millions format: $1.6M / $2.4M / $0.7M
// Millions notation only when the amount is actually in the millions — a
// $5,000 raise reads '$5,000', not '$0.0M'.
const usdM = (n) => {
  const v = Number(n ?? 0);
  return v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M'
    : '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const CHIP_ACTIVE = 'border:1px solid var(--ink,#0a0a0a);border-radius:100px;padding:9px 18px;font-weight:600;cursor:pointer';
const CHIP_IDLE = 'border:1px dotted var(--dt2,#c6c6c6);border-radius:100px;padding:9px 18px;color:var(--mut,#757575);cursor:pointer';

// Modal building blocks (mirrors app.js design tokens)
const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const MONO_LABEL = "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575);margin:12px 0 6px";
const INPUT_CSS = "width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dt,#d9d9d9);border-radius:12px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
const BTN_CSS = 'padding:12px 0;text-align:center;background:var(--ink,#0a0a0a);color:var(--inv,#fff);border-radius:100px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px';

export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    root.dataset.hydrated = '1';
    setup(root, ctx);
  }
  try {
    const { fundraiser } = await ctx.api.get('/api/fundraiser');
    showEmpty(root, ctx, false);
    apply(root, ctx, fundraiser);
  } catch (e) {
    // No open raise — show the honest empty state instead of placeholders.
    if (e?.status === 404) return showEmpty(root, ctx, true);
    // Anonymous visitors get a 401 here — keep the neutral placeholders quietly.
    if (ctx.me()) ctx.errToast(e);
  }
}

// ---- empty state (no open fundraiser) -----------------------------------------
function showEmpty(root, ctx, on) {
  const main = ctx.slot(root, 'fund.main');
  const empty = ctx.slot(root, 'fund.empty');
  if (main) main.style.display = on ? 'none' : '';
  if (empty) empty.style.display = on ? '' : 'none';
}

// ---- one-time wiring --------------------------------------------------------
function setup(root, ctx) {
  ctx.setAction('demoContribute', () => contribute(root, ctx));
  for (const chip of root.querySelectorAll('[data-chip]')) {
    chip.addEventListener('click', () => onChip(root, ctx, chip.dataset.chip));
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onChip(root, ctx, chip.dataset.chip);
      }
    });
  }
}

function onChip(root, ctx, key) {
  if (key === 'custom') return openCustom(root, ctx);
  S.amount = Number(key);
  S.activeChip = key;
  paintChips(root, ctx);
}

function paintChips(root, ctx) {
  for (const chip of root.querySelectorAll('[data-chip]')) {
    const key = chip.dataset.chip;
    const active = key === S.activeChip;
    chip.style.cssText = active ? CHIP_ACTIVE : CHIP_IDLE;
    chip.classList.toggle('obh-1', !active);
    if (key === 'custom') {
      chip.textContent = active ? ctx.fmt.usd(S.amount) : 'CUSTOM';
    }
  }
  refreshCta(root, ctx);
}

function refreshCta(root, ctx) {
  const cta = ctx.slot(root, 'fund.ctaLabel');
  if (cta) cta.textContent = `Back ${S.ventureName} · ${ctx.fmt.usd(S.amount)}`;
}

// ---- custom amount (design-styled modal) --------------------------------------
function openCustom(root, ctx) {
  const m = ctx.buildModal('CUSTOM CONTRIBUTION', 'volunteer_activism');
  m.body.appendChild(el('div', MONO_LABEL, `AMOUNT · USDC · MIN ${ctx.fmt.usd(S.min)}`));
  const input = el('input', INPUT_CSS);
  input.type = 'number';
  input.min = String(S.min);
  input.step = '1';
  input.placeholder = String(S.min);
  m.body.appendChild(input);
  const confirm = () => {
    const v = Math.round(Number(input.value));
    if (!Number.isFinite(v) || v <= 0) return ctx.toast('ENTER AN AMOUNT', 'err');
    if (v < S.min) return ctx.toast(`MINIMUM CONTRIBUTION IS ${ctx.fmt.usd(S.min)}`, 'err');
    S.amount = v;
    S.activeChip = 'custom';
    paintChips(root, ctx);
    m.close();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
  const btn = el('div', BTN_CSS, 'Set amount');
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.addEventListener('click', confirm);
  m.body.appendChild(btn);
  input.focus();
}

// ---- contribute ----------------------------------------------------------------
async function contribute(root, ctx) {
  if (!ctx.me()) {
    ctx.nav('login');
    ctx.toast('SIGN IN TO BACK THIS RAISE', 'err');
    return;
  }
  const amount = S.amount;
  try {
    const r = await ctx.api.post('/api/fundraiser/contribute', { amount });
    apply(root, ctx, r.fundraiser);
    await ctx.refreshMe();
    ctx.toast(`CONTRIBUTION PLEDGED · ${ctx.fmt.usd(amount)} · ${ctx.fmt.pct(r.fundraiser?.pct, 0)} FUNDED`);
  } catch (e) { ctx.errToast(e); }
}

// ---- fill slots -----------------------------------------------------------------
function apply(root, ctx, f) {
  if (!f) return;
  const { fmt } = ctx;
  S.min = f.minAmount ?? S.min;
  S.ventureName = f.ventureName || S.ventureName;

  const set = (name, v) => {
    const n = ctx.slot(root, name);
    if (n) n.textContent = v;
  };

  // Eyebrow: the venture's sector when the API provides one, else a generic,
  // claim-free label. (No audit/series claims — those never existed in code.)
  set('fund.eyebrow', f.sector
    ? `${String(f.sector).toUpperCase()} · MEMBER FUNDRAISER`
    : 'MEMBER FUNDRAISER');

  set('fund.raised', usdM(f.raised));
  set('fund.ofTarget', `OF ${usdM(f.target)} · ${fmt.pct(f.pct, 0)}`);
  const fill = ctx.slot(root, 'fund.meterFill');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(f.pct) || 0))}%`;
  set('fund.backers', fmt.num(f.backers));
  set('fund.timeLeft', `${f.daysLeft ?? 0}D ${f.hoursLeft ?? 0}H`);
  set('fund.apy', fmt.pct(f.apy, 1));
  set('fund.min', fmt.usd(f.minAmount));
  if (f.title) set('fund.title', String(f.title).toUpperCase());
  // The partial's tail already renders "Backed by proposal <code>, currently at
  // <pct> FOR", so drop any trailing "Backed by proposal …" clause the stored
  // blurb may carry to avoid a duplicated proposal reference.
  if (f.blurb) set('fund.blurb', String(f.blurb).replace(/\s*Backed by proposal[^.]*\.?\s*$/i, ''));
  // "Backed by proposal …" tail — only shown when a real backing proposal exists.
  const proposalLine = ctx.slot(root, 'fund.proposalLine');
  if (f.proposalCode) {
    set('fund.proposalCode', f.proposalCode);
    set('fund.proposalForPct', f.proposalForPct != null ? fmt.pct(f.proposalForPct, 0) : '—');
    if (proposalLine) proposalLine.style.display = '';
  } else if (proposalLine) {
    proposalLine.style.display = 'none';
  }
  // Backer social proof — real count only. We have no backer identities from the
  // API (fundraiserView returns just a count), so we never fabricate @handles or
  // initials. The avatar cluster is a non-identifying decoration; hide it when
  // nobody has backed yet so it can't imply members who don't exist.
  const backerCount = Number(f.backers) || 0;
  const line = ctx.slot(root, 'fund.backerLine');
  if (line) {
    line.textContent = backerCount > 0
      ? `${fmt.num(backerCount)} ${backerCount === 1 ? 'person has' : 'people have'} backed this raise`
      : 'Be the first to back this raise';
  }
  const avatars = ctx.slot(root, 'fund.backerAvatars');
  if (avatars) avatars.style.display = backerCount > 0 ? 'flex' : 'none';
  const backersCard = ctx.slot(root, 'fund.backersCard');
  if (backersCard) backersCard.style.display = 'flex';

  // USE OF FUNDS — hidden entirely until real budget lines exist (the API
  // currently always sends []); dotted meters sized by share of target.
  const uofPanel = ctx.slot(root, 'fund.uofPanel');
  if (uofPanel) {
    uofPanel.style.display = Array.isArray(f.useOfFunds) && f.useOfFunds.length ? '' : 'none';
  }
  const uof = ctx.list(root, 'fund.useOfFunds');
  if (uof && Array.isArray(f.useOfFunds)) {
    uof.clear();
    const total = (Number(f.target) > 0 ? Number(f.target)
      : f.useOfFunds.reduce((s, u) => s + (Number(u.amount) || 0), 0)) || 1;
    f.useOfFunds.forEach((u, i) => {
      const row = uof.add();
      const name = ctx.slot(row, 'fund.uofName');
      if (name) name.textContent = u.label ?? u.name ?? '';
      const amt = ctx.slot(row, 'fund.uofAmount');
      if (amt) amt.textContent = usdM(u.amount);
      const meter = ctx.slot(row, 'fund.uofMeter');
      if (meter) {
        const share = Math.max(0, Math.min(100, Math.round(((Number(u.amount) || 0) / total) * 100)));
        meter.style.width = `${share}%`;
        meter.style.backgroundImage =
          `radial-gradient(circle,${UOF_COLORS[i % UOF_COLORS.length]} 1.6px,transparent 2.1px)`;
      }
    });
  }

  // UPDATES — hidden entirely until real updates exist (the API currently
  // always sends []); mono date, bold lead + body.
  const updPanel = ctx.slot(root, 'fund.updPanel');
  if (updPanel) {
    updPanel.style.display = Array.isArray(f.updates) && f.updates.length ? '' : 'none';
  }
  const upd = ctx.list(root, 'fund.updates');
  if (upd && Array.isArray(f.updates)) {
    upd.clear();
    for (const u of f.updates) {
      const row = upd.add();
      const d = ctx.slot(row, 'fund.updDate');
      if (d) {
        const iso = String(u.date ?? '');
        d.textContent = fmt.date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + ' 00:00' : iso);
      }
      const t = ctx.slot(row, 'fund.updTitle');
      const title = String(u.title ?? '');
      if (t) t.textContent = /[.!?]$/.test(title) ? title : title + '.';
      const b = ctx.slot(row, 'fund.updBody');
      if (b) b.textContent = ' ' + String(u.body ?? '');
    }
  }

  refreshCta(root, ctx);
}
