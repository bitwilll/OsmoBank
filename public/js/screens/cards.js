/* Cards screen hydrator.
 * Primary OSMOCARD panel from GET /api/cards (first card; auto-issues one if the
 * list is empty). Freeze toggles PATCH {frozen}; Details reveals the PAN behind a
 * passphrase (POST :id/reveal); Limits PATCHes {dailyLimit}; ADD DIGITAL CARD POSTs
 * a new card. JULY SPEND + category breakdown come from the same GET. Gift store
 * buttons POST /api/cards/gift and refresh the balance. All server data via textContent.
 * Design: only the primary panel is shown, so extra issued cards just refill the
 * primary and toast (no extra panels templated). */

// ---- design-styled element helpers (mirrors app.js / goals.js conventions) ----
const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const monoLabel = (t) => el('div', "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575);margin:12px 0 6px", t);
const inputCss = "width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dt,#d9d9d9);border-radius:12px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
const btnCss = 'padding:12px 0;text-align:center;background:var(--ink,#0a0a0a);color:var(--inv,#fff);border-radius:100px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px';
const btnGhostCss = 'padding:11px 0;text-align:center;border:1px solid var(--dt,#d9d9d9);border-radius:100px;font-size:13.5px;font-weight:600;cursor:pointer;margin-top:9px';

// gift-store chip styling (mirrors the design's active vs idle chip)
const CHIP_ACTIVE = 'border:1px solid var(--ink,#0a0a0a);border-radius:100px;padding:5px 12px;font-weight:600;cursor:pointer';
const CHIP_IDLE = 'border:1px dotted var(--dt2,#c6c6c6);border-radius:100px;padding:5px 12px;color:var(--mut,#757575);cursor:pointer';

function numInput(placeholder, value) {
  const i = el('input', inputCss);
  i.type = 'number';
  i.min = '0';
  i.step = 'any';
  i.placeholder = placeholder;
  if (value !== undefined) i.value = String(value);
  return i;
}

const btn = (css, text) => {
  const b = el('div', css, text);
  b.setAttribute('role', 'button');
  b.setAttribute('tabindex', '0');
  return b;
};

// primary card, refreshed by fill() and read by the action handlers.
let primaryCard = null;
let issuing = false; // guards the empty-list auto-issue against re-entry

// ---- hydrator ----------------------------------------------------------------
export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    ctx.setAction('cardFreeze', () => freezeCard(root, ctx));
    ctx.setAction('cardDetails', () => openDetails(ctx));
    ctx.setAction('cardLimits', () => openLimits(root, ctx));
    ctx.setAction('cardAdd', () => addCard(root, ctx));
    ctx.setAction('giftChip', (chip) => selectChip(chip));
    ctx.setAction('giftBuy', (button) => buyGift(button, ctx));
    root.dataset.hydrated = '1';
  }
  await fill(root, ctx);
}

async function fill(root, ctx) {
  let data;
  try {
    data = await ctx.api.get('/api/cards');
  } catch (e) {
    ctx.errToast(e);
    return;
  }
  let cards = data.cards || [];

  // Empty vault: auto-issue a card once, then re-read.
  if (!cards.length && !issuing) {
    issuing = true;
    try {
      await ctx.api.post('/api/cards', { brand: 'OSMO' });
      data = await ctx.api.get('/api/cards');
      cards = data.cards || [];
    } catch (e) {
      ctx.errToast(e);
    } finally {
      issuing = false;
    }
  }
  primaryCard = cards[0] || null;

  fillHolder(root, ctx);
  fillPanel(root);
  fillSpend(root, ctx, data);
}

function fillHolder(root, ctx) {
  const holder = ctx.slot(root, 'cards.holder');
  if (!holder) return;
  const me = ctx.me();
  const parts = (me?.user?.name || '').trim().split(/\s+/).filter(Boolean);
  const label = parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : (parts[0] || '');
  if (label) holder.textContent = label.toUpperCase();
}

function fillPanel(root) {
  const panel = root.querySelector('[data-slot="cards.panel"]');
  const numEl = root.querySelector('[data-slot="cards.number"]');
  const expEl = root.querySelector('[data-slot="cards.exp"]');
  const frozenChip = root.querySelector('[data-slot="cards.frozenChip"]');
  const freezeLabel = root.querySelector('[data-slot="cards.freezeLabel"]');
  const c = primaryCard;
  if (!c) return;

  if (numEl) numEl.textContent = `•••• •••• •••• ${c.last4 || '0000'}`;
  if (expEl) expEl.textContent = `EXP ${c.exp || '--/--'} · ${String(c.kind || 'virtual').toUpperCase()}`;
  if (panel) panel.style.opacity = c.frozen ? '.5' : '1';
  if (frozenChip) frozenChip.style.display = c.frozen ? 'inline-block' : 'none';
  if (freezeLabel) freezeLabel.textContent = c.frozen ? 'Unfreeze' : 'Freeze';
}

function fillSpend(root, ctx, data) {
  const month = new Date().toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
  const title = ctx.slot(root, 'cards.spendTitle');
  if (title) title.textContent = `${month} SPEND · ${ctx.fmt.usd2(data.spend || 0)}`;

  const bd = data.spendBreakdown || {};
  const rows = [
    ['cards.catGroceries', bd.groceries],
    ['cards.catTransit', bd.transit],
    ['cards.catDining', bd.dining],
  ];
  for (const [name, val] of rows) {
    const cell = ctx.slot(root, name);
    if (cell) cell.textContent = ctx.fmt.usd(val || 0);
  }
}

// ---- card actions ------------------------------------------------------------
async function freezeCard(root, ctx) {
  if (!primaryCard) return;
  const wasFrozen = primaryCard.frozen;
  try {
    await ctx.api.patch(`/api/cards/${primaryCard.id}`, { frozen: !wasFrozen });
    ctx.toast(wasFrozen ? 'CARD UNFROZEN' : 'CARD FROZEN');
    await fill(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

function openDetails(ctx) {
  if (!primaryCard) return;
  const card = primaryCard;
  const m = ctx.buildModal('CARD DETAILS', 'visibility');

  m.body.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--mut,#757575);line-height:1.6",
    'Enter your passphrase to reveal the full card number, CVV, and expiry.'));

  m.body.appendChild(monoLabel('PASSPHRASE'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'your passphrase';
  m.body.appendChild(pass);

  const out = el('div', 'margin-top:6px');
  const reveal = btn(btnCss, 'Reveal card');
  const doReveal = async () => {
    try {
      const r = await ctx.api.post(`/api/cards/${card.id}/reveal`, { passphrase: pass.value });
      out.textContent = '';
      out.appendChild(monoLabel('CARD NUMBER'));
      out.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:18px;letter-spacing:.16em;color:var(--ink,#0a0a0a)", r.pan || ''));

      const grid = el('div', 'display:flex;gap:36px;margin-top:12px');
      const cvvCol = el('div');
      cvvCol.appendChild(monoLabel('CVV'));
      cvvCol.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:15px;letter-spacing:.12em;color:var(--ink,#0a0a0a)", r.cvv || ''));
      const expCol = el('div');
      expCol.appendChild(monoLabel('EXPIRES'));
      expCol.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:15px;letter-spacing:.12em;color:var(--ink,#0a0a0a)", r.exp || ''));
      grid.append(cvvCol, expCol);
      out.appendChild(grid);

      const copy = btn(btnGhostCss, 'Copy number');
      copy.addEventListener('click', () => {
        const digits = String(r.pan || '').replace(/\s+/g, '');
        Promise.resolve(navigator.clipboard?.writeText(digits))
          .then(() => ctx.toast('CARD NUMBER COPIED'))
          .catch(() => {});
      });
      out.appendChild(copy);
    } catch (e) { ctx.errToast(e); }
  };
  reveal.addEventListener('click', doReveal);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doReveal(); } });
  m.body.appendChild(reveal);
  m.body.appendChild(out);
  pass.focus();
}

function openLimits(root, ctx) {
  if (!primaryCard) return;
  const card = primaryCard;
  const m = ctx.buildModal('SPENDING LIMIT', 'tune');

  m.body.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--mut,#757575);line-height:1.6",
    'Daily spend cap for this card. Purchases above it are declined.'));
  m.body.appendChild(monoLabel('DAILY LIMIT (USD)'));
  const inp = numInput('0', card.dailyLimit ?? 0);
  m.body.appendChild(inp);

  const save = btn(btnCss, 'Update limit');
  const doSave = async () => {
    try {
      const dailyLimit = Number(inp.value);
      await ctx.api.patch(`/api/cards/${card.id}`, { dailyLimit });
      m.close();
      await fill(root, ctx);
      ctx.toast(`LIMIT UPDATED · ${ctx.fmt.usd(dailyLimit)}/DAY`);
    } catch (e) { ctx.errToast(e); }
  };
  save.addEventListener('click', doSave);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  m.body.appendChild(save);
  inp.focus();
}

async function addCard(root, ctx) {
  try {
    const r = await ctx.api.post('/api/cards', { brand: 'OSMO' });
    await fill(root, ctx);
    ctx.toast(`CARD ISSUED · ****${r.card?.last4 || ''}`);
  } catch (e) { ctx.errToast(e); }
}

// ---- gift store --------------------------------------------------------------
function selectChip(chip) {
  const cardEl = chip.closest('[data-brand]');
  if (!cardEl) return;
  for (const c of cardEl.querySelectorAll('[data-action="giftChip"]')) {
    c.style.cssText = CHIP_IDLE;
    delete c.dataset.selected;
  }
  chip.style.cssText = CHIP_ACTIVE;
  chip.dataset.selected = '1';
}

async function buyGift(button, ctx) {
  const cardEl = button.closest('[data-brand]');
  if (!cardEl) return;
  const brand = cardEl.dataset.brand;
  const sel = cardEl.querySelector('[data-action="giftChip"][data-selected]')
    || cardEl.querySelector('[data-action="giftChip"]');
  const amount = Number(sel?.dataset.amt || 0);
  if (!brand || !amount) return;
  try {
    const r = await ctx.api.post('/api/cards/gift', { brand, amount });
    await ctx.refreshMe(); // balance changed
    ctx.toast(`GIFT CARD PURCHASED · ${brand} ${ctx.fmt.usd(amount)} · CODE ${r.gift?.code || ''}`);
  } catch (e) { ctx.errToast(e); }
}
