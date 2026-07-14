/* Cards screen hydrator.
 * Primary OSMOCARD panel from GET /api/cards (first card; auto-issues one if the
 * list is empty). Freeze toggles PATCH {frozen}; Details reveals the PAN behind a
 * passphrase (POST :id/reveal); Limits PATCHes {dailyLimit}; ADD DIGITAL CARD POSTs
 * a new card. Month spend + the {transfers, gifts} breakdown come from the same
 * GET — both are real ledger aggregates, never invented categories. Gift store
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
  fillWallet(root, ctx);
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

  if (numEl) numEl.textContent = `•••• •••• •••• ${c.last4 || '••••'}`;
  if (expEl) expEl.textContent = `EXP ${c.exp || '--/--'} · ${String(c.kind || 'virtual').toUpperCase()}`;
  if (panel) panel.style.opacity = c.frozen ? '.5' : '1';
  if (frozenChip) frozenChip.style.display = c.frozen ? 'inline-block' : 'none';
  if (freezeLabel) freezeLabel.textContent = c.frozen ? 'Unfreeze' : 'Freeze';
}

function fillSpend(root, ctx, data) {
  const bd = data.spendBreakdown || {};
  const transfers = Number(bd.transfers || 0);
  const gifts = Number(bd.gifts || 0);
  const total = transfers + gifts;

  const month = new Date().toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
  const title = ctx.slot(root, 'cards.spendTitle');
  if (title) title.textContent = `${month} SPEND · ${ctx.fmt.usd2(total)}`;

  const rows = [
    ['cards.catTransfers', 'cards.barTransfers', transfers],
    ['cards.catGifts', 'cards.barGifts', gifts],
  ];
  for (const [cellName, barName, amount] of rows) {
    const cell = ctx.slot(root, cellName);
    if (cell) cell.textContent = ctx.fmt.usd(amount);
    // Bar fill = this row's share of month spend. A $0 account has nothing
    // to spend, so the bar stays empty rather than showing a fabricated width.
    const bar = ctx.slot(root, barName);
    if (bar) {
      const share = total > 0 ? Math.max(0, Math.min(100, (amount / total) * 100)) : 0;
      bar.style.width = `${share}%`;
    }
  }
}

// ---- mobile-wallet provisioning (Apple / Google / Samsung Pay) ---------------
const WALLET_META = {
  apple: { label: 'Apple Pay', icon: 'phone_iphone' },
  google: { label: 'Google Pay', icon: 'android' },
  samsung: { label: 'Samsung Wallet', icon: 'smartphone' },
};
const WALLET_BTN = 'padding:11px 16px;display:flex;align-items:center;gap:7px;background:var(--ink,#0a0a0a);color:var(--inv,#fff);border-radius:100px;font-size:13px;font-weight:600;cursor:pointer';
const WALLET_BTN_ON = 'padding:11px 16px;display:flex;align-items:center;gap:7px;border:1px solid var(--grn,#17a562);color:var(--grn,#17a562);border-radius:100px;font-size:13px;font-weight:600;cursor:pointer';

// Best-effort guess so the native wallet for this device is offered first. All
// three remain available — the user may be provisioning for another device.
function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/SamsungBrowser|SM-[A-Z0-9]/.test(ua)) return 'samsung';
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua)) return 'apple';
  if (/Android/.test(ua)) return 'google';
  return null;
}

function fillWallet(root, ctx) {
  const box = ctx.slot(root, 'cards.walletBtns');
  const status = ctx.slot(root, 'cards.walletStatus');
  if (!box) return;
  box.textContent = '';
  const c = primaryCard;
  if (!c) {
    if (status) status.textContent = 'Issue a card to add it to a mobile wallet.';
    return;
  }
  const provisioned = new Set((c.wallets || []).map((w) => w.platform));
  const detected = detectPlatform();
  const order = [detected, 'apple', 'google', 'samsung'].filter((v, i, a) => v && a.indexOf(v) === i);

  for (const key of order) {
    const meta = WALLET_META[key];
    const on = provisioned.has(key);
    const b = btn(on ? WALLET_BTN_ON : WALLET_BTN, '');
    b.appendChild(el('span', "font-family:'Material Symbols Sharp';font-size:16px;line-height:1", on ? 'check_circle' : meta.icon));
    b.appendChild(el('span', '', on ? `In ${meta.label}` : `Add to ${meta.label}`));
    b.addEventListener('click', () => (on ? removeFromWallet(key, ctx, root) : addToWallet(key, ctx, root)));
    box.appendChild(b);
  }
  if (status) {
    status.textContent = provisioned.size
      ? `In ${[...provisioned].map((p) => WALLET_META[p].label).join(', ')}. Tap a wallet to remove it.`
      : 'Add this card to Apple Pay, Google Pay, or Samsung Wallet for tap-to-pay on your phone.';
  }
}

async function addToWallet(platform, ctx, root) {
  if (!primaryCard) return;
  try {
    const device = (navigator.platform || 'this device').slice(0, 60);
    const r = await ctx.api.post(`/api/cards/${primaryCard.id}/provision`, { platform, device });
    await fill(root, ctx);
    showWalletResult(ctx, r);
  } catch (e) { ctx.errToast(e); }
}

async function removeFromWallet(platform, ctx, root) {
  if (!primaryCard) return;
  try {
    await ctx.api.del(`/api/cards/${primaryCard.id}/provision/${platform}`);
    await fill(root, ctx);
    ctx.toast(`REMOVED FROM ${WALLET_META[platform].label.toUpperCase()}`);
  } catch (e) { ctx.errToast(e); }
}

function showWalletResult(ctx, r) {
  const m = ctx.buildModal(`ADDED TO ${String(r.wallet || 'WALLET').toUpperCase()}`, 'account_balance_wallet');
  m.body.appendChild(el('div', 'font-size:13.5px;line-height:1.6;color:var(--ink,#0a0a0a)',
    `Your OsmoCard ending ${r.card?.last4 || '••••'} is now available in ${r.wallet}.`));
  m.body.appendChild(monoLabel('DEVICE ACCOUNT NUMBER (TOKEN)'));
  m.body.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:15px;letter-spacing:.14em;color:var(--ink,#0a0a0a)", r.tokenRef || ''));
  m.body.appendChild(el('div', 'font-size:12px;color:var(--mut,#757575);line-height:1.6;margin-top:8px',
    'Your real card number is never shared with the wallet — this device-specific token stands in and can be revoked without reissuing your card.'));
  if (r.simulated) {
    m.body.appendChild(el('div', 'font-size:11.5px;color:var(--fnt,#a3a3a3);line-height:1.6;margin-top:12px;border-top:1px dotted var(--dt2,#c6c6c6);padding-top:10px',
      'Sandbox provisioning. Live Apple / Google / Samsung Pay enrolment completes inside the OsmoBank mobile app, which passes this token to the platform via issuer↔network push-provisioning (Visa VTS / Mastercard MDES).'));
  }
  const done = btn(btnCss, 'Done');
  done.addEventListener('click', () => m.close());
  m.body.appendChild(done);
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
    const backOsm = Number(r.gift?.backOsm || 0);
    const backTxt = backOsm > 0 ? ` · +${ctx.fmt.num(backOsm)} OSM BACK` : '';
    ctx.toast(`GIFT CARD PURCHASED · ${brand} ${ctx.fmt.usd(amount)} · CODE ${r.gift?.code || ''}${backTxt}`);
  } catch (e) { ctx.errToast(e); }
}
