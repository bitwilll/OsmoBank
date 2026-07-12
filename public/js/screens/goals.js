/* Goals screen hydrator.
 * Cards from GET /api/goals; edit modal PATCHes (addSaved debits USDC),
 * delete refunds saved balance; "+ New goal" POSTs; auto-save rule toggles
 * stay visual-only (demo). All server data goes through textContent. */

const CATEGORIES = ['TRAVEL', 'SAFETY NET', 'HOME', 'SAVINGS'];
const CATEGORY_ICONS = {
  TRAVEL: 'travel',
  'SAFETY NET': 'shield',
  HOME: 'roofing',
  SAVINGS: 'savings',
};

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
const btnGhostRedCss = 'padding:11px 0;text-align:center;border:1px solid var(--red,#c47b10);color:var(--red,#c47b10);border-radius:100px;font-size:13.5px;font-weight:600;cursor:pointer;margin-top:9px';

function numInput(placeholder, value) {
  const i = el('input', inputCss);
  i.type = 'number';
  i.min = '0';
  i.step = 'any';
  i.placeholder = placeholder;
  if (value !== undefined) i.value = String(value);
  return i;
}

const goalIcon = (g) => ((g.icon && g.icon !== 'flag') ? g.icon : (CATEGORY_ICONS[g.category] || 'flag'));

const monthYearUp = (d) => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();

function etaLabel(g) {
  if (g.eta) {
    const raw = String(g.eta);
    const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    return 'ETA ' + (Number.isNaN(d.getTime()) ? raw.toUpperCase() : monthYearUp(d));
  }
  if (!g.autosave || g.autosave <= 0) return 'ETA —';
  const remaining = Math.max(0, (g.target || 0) - (g.saved || 0));
  const months = Math.ceil(remaining / g.autosave);
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return 'ETA ' + monthYearUp(d);
}

// ---- hydrator ----------------------------------------------------------------
export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    ctx.setAction('demoGoal', () => openNewGoal(root, ctx));
    ctx.setAction('demoRule', (pill) => toggleRule(pill, ctx));
    root.dataset.hydrated = '1';
  }
  await fill(root, ctx);
}

async function fill(root, ctx) {
  let goals;
  try {
    ({ goals } = await ctx.api.get('/api/goals'));
  } catch (e) {
    ctx.errToast(e);
    return;
  }
  const cards = ctx.list(root, 'goals.cards');
  if (!cards) return;
  cards.clear();
  for (const g of goals) {
    const row = cards.add();
    ctx.slot(row, 'icon').textContent = goalIcon(g);
    ctx.slot(row, 'category').textContent = String(g.category || 'SAVINGS').toUpperCase();
    ctx.slot(row, 'name').textContent = g.name;

    const hot = g.pct >= 75;
    const pctEl = ctx.slot(row, 'pct');
    pctEl.textContent = ctx.fmt.pct(g.pct, 0);
    pctEl.style.color = hot ? 'var(--grn,#17a562)' : 'var(--ink,#0a0a0a)';

    ctx.slot(row, 'amounts').textContent = `${ctx.fmt.usd(g.saved)} / ${ctx.fmt.usd(g.target)}`;

    const meter = ctx.slot(row, 'meterFill');
    meter.style.width = `${Math.max(0, Math.min(100, g.pct || 0))}%`;
    meter.style.backgroundImage =
      `radial-gradient(circle,${hot ? 'var(--grn,#17a562)' : 'var(--ink,#0a0a0a)'} 1.6px,transparent 2.1px)`;

    ctx.slot(row, 'autosave').textContent = `AUTO-SAVE ${ctx.fmt.usd(g.autosave)}/MO`;
    ctx.slot(row, 'eta').textContent = etaLabel(g);

    const pencil = ctx.slot(row, 'edit');
    pencil.addEventListener('click', () => openEditGoal(g, root, ctx));
    pencil.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditGoal(g, root, ctx); }
    });
  }
}

// ---- edit goal modal -----------------------------------------------------------
function openEditGoal(g, root, ctx) {
  const m = ctx.buildModal('EDIT GOAL', 'edit');

  m.body.appendChild(el('div', "font-family:'Doto',monospace;font-weight:900;font-size:22px;letter-spacing:.02em", String(g.name).toUpperCase()));
  m.body.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--mut,#757575);margin-top:4px;letter-spacing:.06em",
    `${g.category} · ${ctx.fmt.usd(g.saved)} SAVED OF ${ctx.fmt.usd(g.target)}`));

  const bal = ctx.me()?.balances?.USDC ?? 0;
  m.body.appendChild(monoLabel(`ADD FUNDS · ${ctx.fmt.usd2(bal)} USDC AVAILABLE`));
  const add = numInput('0.00');
  m.body.appendChild(add);

  m.body.appendChild(monoLabel('AUTO-SAVE PER MONTH (USDC)'));
  const autosave = numInput('0', g.autosave);
  m.body.appendChild(autosave);

  m.body.appendChild(monoLabel('TARGET (USDC)'));
  const target = numInput('10000', g.target);
  m.body.appendChild(target);

  const save = el('div', btnCss, 'Save changes');
  save.setAttribute('role', 'button');
  save.setAttribute('tabindex', '0');
  save.addEventListener('click', async () => {
    try {
      const body = { target: Number(target.value), autosave: Number(autosave.value) || 0 };
      const extra = Number(add.value);
      if (extra > 0) body.addSaved = extra;
      await ctx.api.patch(`/api/goals/${g.id}`, body);
      if (extra > 0) await ctx.refreshMe(); // addSaved debited the USDC ledger
      m.close();
      await fill(root, ctx);
      ctx.toast('GOAL UPDATED');
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(save);

  const del = el('div', btnGhostRedCss, 'Delete goal');
  del.setAttribute('role', 'button');
  del.setAttribute('tabindex', '0');
  let armed = false;
  del.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      del.textContent = `Confirm close — refunds saved balance (${ctx.fmt.usd(g.saved)})`;
      return;
    }
    try {
      await ctx.api.del(`/api/goals/${g.id}`);
      await ctx.refreshMe(); // saved balance returned to the USDC ledger
      m.close();
      await fill(root, ctx);
      ctx.toast(`GOAL CLOSED · ${ctx.fmt.usd(g.saved)} RETURNED`);
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(del);
}

// ---- new goal modal -----------------------------------------------------------
function openNewGoal(root, ctx) {
  const m = ctx.buildModal('NEW GOAL', 'flag');

  m.body.appendChild(monoLabel('NAME'));
  const name = el('input', inputCss);
  name.placeholder = 'e.g. Kyoto sabbatical';
  m.body.appendChild(name);

  m.body.appendChild(monoLabel('CATEGORY'));
  const cat = el('select', inputCss + ';cursor:pointer');
  for (const c of CATEGORIES) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    cat.appendChild(o);
  }
  m.body.appendChild(cat);

  m.body.appendChild(monoLabel('TARGET (USDC)'));
  const target = numInput('10000');
  m.body.appendChild(target);

  m.body.appendChild(monoLabel('AUTO-SAVE PER MONTH (OPTIONAL)'));
  const autosave = numInput('0');
  m.body.appendChild(autosave);

  const create = el('div', btnCss, 'Create goal');
  create.setAttribute('role', 'button');
  create.setAttribute('tabindex', '0');
  create.addEventListener('click', async () => {
    try {
      await ctx.api.post('/api/goals', {
        name: name.value.trim(),
        category: cat.value,
        icon: CATEGORY_ICONS[cat.value] || 'flag',
        target: Number(target.value),
        autosave: Number(autosave.value) || 0,
      });
      m.close();
      await fill(root, ctx);
      ctx.toast('GOAL CREATED');
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(create);
  name.focus();
}

// ---- auto-save rules (visual demo toggles) --------------------------------------
function toggleRule(pill, ctx) {
  if (!pill || !pill.firstElementChild) return;
  const on = pill.dataset.on !== undefined
    ? pill.dataset.on === '1'
    : (pill.getAttribute('style') || '').includes('--grn');
  const next = !on;
  pill.dataset.on = next ? '1' : '0';
  pill.style.background = next
    ? 'var(--grn,#17a562)'
    : 'color-mix(in srgb,var(--inv,#fff) 25%,transparent)';
  const knob = pill.firstElementChild;
  knob.style.left = next ? 'auto' : '3px';
  knob.style.right = next ? '3px' : 'auto';
  ctx.toast('RULE UPDATED · DEMO');
}
