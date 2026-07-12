/* Ventures marketplace hydrator.
 * Cards from GET /api/ventures + header stats from GET /api/portfolio.
 * Per-card invest drives the shared stake modal; managers/admins get a
 * "distribute payout" modal on ventures they run and a "list venture" modal.
 * Client-side sector filter + APY sort re-render from cached data.
 * All server/user data goes through textContent (never innerHTML). */

const SECTOR_ICON = {
  ENERGY: 'solar_power',
  ROBOTICS: 'precision_manufacturing',
  LOGISTICS: 'local_shipping',
  OCEAN: 'waves',
  DATA: 'hub',
  INFRA: 'water_drop',
  AGRI: 'agriculture',
};

// chip styling (matches the partial's active/inactive markup exactly)
const CHIP_ACTIVE = 'padding:8px 18px;border-radius:100px;background:var(--ink,#0a0a0a);color:var(--inv,#fff);font-weight:600;cursor:pointer';
const CHIP_INACTIVE = 'padding:8px 18px;border-radius:100px;border:1px dotted var(--dt2,#c6c6c6);color:var(--mut,#757575);cursor:pointer';

// ---- design-styled element helpers (mirrors app.js modal conventions) -------
const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const monoLabel = (t) => el('div', "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575);margin:12px 0 6px", t);
const inputCss = "width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dt,#d9d9d9);border-radius:12px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
const btnCss = 'padding:12px 0;text-align:center;background:var(--ink,#0a0a0a);color:var(--inv,#fff);border-radius:100px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px';

function textInput(placeholder) {
  const i = el('input', inputCss);
  if (placeholder) i.placeholder = placeholder;
  return i;
}
function numInput(placeholder) {
  const i = el('input', inputCss);
  i.type = 'number';
  i.min = '0';
  i.step = 'any';
  if (placeholder) i.placeholder = placeholder;
  return i;
}
function selectInput(options) {
  const s = el('select', inputCss + ';cursor:pointer');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    s.appendChild(opt);
  }
  return s;
}

// one-decimal APY, e.g. 12.4 -> "12.4"
const fmtApy = (n) => Number(n ?? 0).toFixed(1);

// ---- hydrator ----------------------------------------------------------------
export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    root.__vent = { data: [], filter: 'ALL', sort: 'desc' };

    ctx.setAction('ventureProspectus', () => ctx.toast('PROSPECTUS · AUDITED BY FIELDSTONE · DEMO'));
    ctx.setAction('ventureFilter', (elx) => {
      root.__vent.filter = (elx && elx.dataset && elx.dataset.sector) || 'ALL';
      applyChipStyles(root);
      renderCards(root, ctx);
    });
    ctx.setAction('ventureSort', () => {
      root.__vent.sort = root.__vent.sort === 'desc' ? 'asc' : 'desc';
      renderCards(root, ctx);
    });
    ctx.setAction('ventureList', () => openListModal(root, ctx));

    root.dataset.hydrated = '1';
  }
  await fill(root, ctx);
}

async function fill(root, ctx) {
  // Guard against overlapping hydrations (screen left + re-entered mid-fetch).
  const seq = (root.__vSeq = (root.__vSeq || 0) + 1);

  let ventures, portfolio;
  try {
    const [vr, pr] = await Promise.all([
      ctx.api.get('/api/ventures'),
      ctx.api.get('/api/portfolio'),
    ]);
    ventures = vr?.ventures || [];
    portfolio = pr || {};
  } catch (e) {
    ctx.errToast(e);
    return;
  }
  if (root.__vSeq !== seq) return;
  root.__vent.data = ventures;

  // ---- header stats ---------------------------------------------------------
  const stake = ventures.reduce((s, v) => s + Number(v.youHold || 0), 0);
  ctx.slot(root, 'ventures.stake').textContent = ctx.fmt.usd(stake);
  ctx.slot(root, 'ventures.returns').textContent = ctx.fmt.signedUsd(Number(portfolio.netPl || 0));
  ctx.slot(root, 'ventures.nextDiv').textContent =
    portfolio.nextDividend ? ctx.fmt.date(portfolio.nextDividend.date) : '—';

  // ---- "+ LIST VENTURE" visibility (managers/admins only) -------------------
  const role = ctx.me()?.user?.role;
  const isManager = role === 'manager' || role === 'admin';
  ctx.slot(root, 'ventures.listBtn').style.display = isManager ? '' : 'none';

  buildChips(root, ctx);
  renderCards(root, ctx);
}

// ---- filter chips (ALL + one per distinct sector) ------------------------------
function buildChips(root, ctx) {
  const data = root.__vent.data;
  const sectors = [...new Set(data.map((v) => v.sector))];
  ctx.slot(root, 'ventures.chipAll').textContent = `ALL · ${ctx.fmt.num(data.length)}`;
  const chips = ctx.list(root, 'ventures.chips');
  if (chips) {
    chips.clear();
    for (const sec of sectors) {
      const chip = chips.add();
      chip.setAttribute('data-sector', sec);
      chip.textContent = sec;
    }
  }
  applyChipStyles(root);
}

function applyChipStyles(root) {
  const active = root.__vent.filter;
  for (const c of root.querySelectorAll('[data-action="ventureFilter"][data-sector]')) {
    c.style.cssText = c.dataset.sector === active ? CHIP_ACTIVE : CHIP_INACTIVE;
  }
}

// ---- card grid -----------------------------------------------------------------
function renderCards(root, ctx) {
  const st = root.__vent;
  const list = ctx.list(root, 'ventures.cards');
  if (!list) return;
  list.clear();

  const sorted = st.data.slice().sort((a, b) => (
    st.sort === 'desc' ? Number(b.apy) - Number(a.apy) : Number(a.apy) - Number(b.apy)
  ));

  const meNow = ctx.me();
  const role = meNow?.user?.role;
  const roles = { isAdmin: role === 'admin', role, myId: meNow?.user?.id };

  for (const v of sorted) {
    if (st.filter !== 'ALL' && v.sector !== st.filter) continue;
    const row = list.add();
    fillCard(row, v, root, ctx, roles);
  }
}

function fillCard(row, v, root, ctx, roles) {
  const { fmt, slot } = ctx;

  slot(row, 'icon').textContent = SECTOR_ICON[v.sector] || 'diamond';
  slot(row, 'sector').textContent = v.sector;
  slot(row, 'name').textContent = v.name;
  slot(row, 'blurb').textContent = v.blurb || '';

  const apyStr = fmtApy(v.apy);
  slot(row, 'apy').textContent = apyStr;
  slot(row, 'apySuffix').textContent = `% APY · PAID ${String(v.payoutFreq || '').toUpperCase()}`;

  const target = Number(v.targetAmount || 0);
  const raised = Number(v.raised || 0);
  const pct = target > 0 ? Math.round((raised / target) * 100) : 0;
  slot(row, 'filled').textContent = `ROUND FILLED ${pct}%`;
  slot(row, 'meterFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  slot(row, 'min').textContent = `MIN $${fmt.num(v.minAmount)}`;

  // ---- you-hold badge (green, only when > 0) --------------------------------
  const youHold = slot(row, 'youHold');
  const hold = Number(v.youHold || 0);
  if (hold > 0) {
    youHold.style.display = '';
    youHold.textContent = `YOU HOLD ${fmt.usd(hold)}`;
  } else {
    youHold.style.display = 'none';
  }

  // ---- status/badges --------------------------------------------------------
  const badgeAmber = slot(row, 'badgeAmber');
  const badgeAmberText = slot(row, 'badgeAmberText');
  const badgeMut = slot(row, 'badgeMut');
  badgeAmber.style.display = 'none';
  badgeMut.style.display = 'none';
  if (v.status === 'pending') {
    badgeAmber.style.display = 'flex';
    badgeAmberText.textContent = 'PENDING REVIEW';
  } else if (v.badge) {
    if (/vote/i.test(v.badge)) {
      badgeAmber.style.display = 'flex';
      badgeAmberText.textContent = v.badge;
    } else {
      badgeMut.style.display = '';
      badgeMut.textContent = v.badge;
    }
  }

  // ---- invest (own handler; drop the static demo data-action) ---------------
  const investBtn = slot(row, 'investBtn');
  investBtn.removeAttribute('data-action');
  investBtn.onclick = () => {
    const bal = Number(ctx.me()?.balances?.USDC || 0);
    const remaining = Math.max(0, Number(v.targetAmount || 0) - Number(v.raised || 0));
    ctx.openInvest({
      name: v.name,
      apy: apyStr,
      max: Math.min(bal, remaining),
      onConfirm: async (amount) => {
        await ctx.api.post(`/api/ventures/${v.id}/invest`, { amount });
        await ctx.refreshMe();
        await fill(root, ctx);
        ctx.toast(`STAKED IN ${String(v.name).toUpperCase()} · ${fmt.usd(amount)}`);
      },
    });
  };

  // ---- distribute payout (venture manager or admin only) --------------------
  const payoutBtn = slot(row, 'payoutBtn');
  payoutBtn.removeAttribute('data-action');
  const canPayout = roles.isAdmin || (roles.role === 'manager' && v.managerId === roles.myId);
  if (canPayout) {
    payoutBtn.style.display = 'flex';
    payoutBtn.onclick = () => openPayoutModal(v, root, ctx);
  } else {
    payoutBtn.style.display = 'none';
    payoutBtn.onclick = null;
  }
}

// ---- distribute payout modal --------------------------------------------------
function openPayoutModal(v, root, ctx) {
  const m = ctx.buildModal('DISTRIBUTE PAYOUT', 'payments');

  m.body.appendChild(el('div', "font-family:'Doto',monospace;font-weight:900;font-size:22px;letter-spacing:.02em", String(v.name).toUpperCase()));
  m.body.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--mut,#757575);margin-top:4px;letter-spacing:.06em",
    `${v.sector} · PRO-RATA TO ACTIVE BACKERS`));

  m.body.appendChild(monoLabel('KIND'));
  const kind = selectInput(['dividend', 'reimbursement']);
  m.body.appendChild(kind);

  m.body.appendChild(monoLabel('TOTAL (USDC)'));
  const total = numInput('0.00');
  m.body.appendChild(total);

  m.body.appendChild(monoLabel('MEMO (OPTIONAL)'));
  const memo = textInput('e.g. Q3 dividend');
  m.body.appendChild(memo);

  const submit = el('div', btnCss, 'Distribute payout');
  submit.setAttribute('role', 'button');
  submit.setAttribute('tabindex', '0');
  submit.addEventListener('click', async () => {
    const amount = Number(total.value || 0);
    const kindVal = kind.value;
    try {
      const r = await ctx.api.post(`/api/ventures/${v.id}/payouts`, {
        kind: kindVal,
        total: amount,
        memo: memo.value.trim(),
      });
      const items = r?.items || [];
      m.close();
      await fill(root, ctx);
      ctx.toast(`${kindVal.toUpperCase()} BATCH SENT · ${ctx.fmt.usd(amount)} TO ${items.length} BACKERS`);
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(submit);
}

// ---- list venture modal -------------------------------------------------------
function openListModal(root, ctx) {
  const m = ctx.buildModal('LIST VENTURE', 'add_business');

  m.body.appendChild(monoLabel('VENTURE NAME'));
  const name = textInput('e.g. Helios Grid');
  m.body.appendChild(name);

  m.body.appendChild(monoLabel('SECTOR'));
  const sector = selectInput(Object.keys(SECTOR_ICON));
  m.body.appendChild(sector);

  m.body.appendChild(monoLabel('BLURB'));
  const blurb = textInput('One line on what this venture does');
  m.body.appendChild(blurb);

  m.body.appendChild(monoLabel('APY (%)'));
  const apy = numInput('12.4');
  m.body.appendChild(apy);

  m.body.appendChild(monoLabel('MINIMUM (USDC)'));
  const min = numInput('100');
  m.body.appendChild(min);

  m.body.appendChild(monoLabel('TARGET RAISE (USDC)'));
  const target = numInput('2400000');
  m.body.appendChild(target);

  const submit = el('div', btnCss, 'Submit for DAO review');
  submit.setAttribute('role', 'button');
  submit.setAttribute('tabindex', '0');
  submit.addEventListener('click', async () => {
    try {
      await ctx.api.post('/api/ventures', {
        name: name.value.trim(),
        sector: sector.value,
        blurb: blurb.value.trim(),
        apy: Number(apy.value || 0),
        minAmount: Number(min.value || 0),
        targetAmount: Number(target.value || 0),
      });
      m.close();
      await fill(root, ctx);
      ctx.toast('SUBMITTED FOR DAO REVIEW');
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(submit);
  name.focus();
}
