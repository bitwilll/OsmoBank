/* Transfer screen hydrator.
 * Wires GET/POST /api/transfers and the client wallet.
 *  - FROM selector cycles USDC (internal ledger) / BTC / ETH (on-chain).
 *  - USDC sends settle instantly via POST /api/transfers.
 *  - BTC/ETH sends require an unlocked device wallet -> wallet.send()
 *    (which records the broadcast via /api/transfers/record internally).
 *  - RECENT RECIPIENTS is filled from GET /api/transfers (top 5).
 * All server/user data goes through textContent only. */

import { getPrices, usdAt } from '../prices.js';

// FROM sources, cycled by the cycleFrom action. The on-chain rows' chain key,
// name and symbol are filled from ctx.wallet at hydrate time so this screen
// tracks whatever network the wallet module is on (mainnet by default).
const FROMS = [
  { key: 'usdc', chain: 'internal', dot: '#2775ca', name: 'USD Coin · internal', sym: 'USDC' },
  { key: 'btc', chain: null, dot: '#f7931a', name: 'Bitcoin', sym: 'BTC' },
  { key: 'eth', chain: null, dot: '#627eea', name: 'Ethereum', sym: 'ETH' },
];

function bindNetwork(ctx) {
  const net = ctx.wallet.IS_MAINNET ? 'mainnet' : (ctx.wallet.NETWORK === 'testnet' ? 'testnet' : ctx.wallet.NETWORK);
  FROMS[1].chain = ctx.wallet.BTC_CHAIN;
  FROMS[1].name = `Bitcoin · ${net}`;
  FROMS[1].sym = ctx.wallet.CHAINS[ctx.wallet.BTC_CHAIN].symbol;
  FROMS[2].chain = ctx.wallet.ETH_CHAIN;
  FROMS[2].name = `Ethereum · ${ctx.wallet.IS_MAINNET ? 'mainnet' : 'sepolia'}`;
  FROMS[2].sym = ctx.wallet.CHAINS[ctx.wallet.ETH_CHAIN].symbol;
}

// Module (closure) state — persists across screen re-activations.
let selectedIdx = 0;      // index into FROMS
let selectedFee = 'std';  // eco|std|pri
let btcFees = null;       // cached mempool recommended fees
let chainBal = {};        // keyed by the wallet's active chain keys (btc/eth on mainnet)

// ---- design-styled element helpers (mirror app.js / goals.js conventions) ----
const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const monoLabel = (t) => el('div', "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575);margin:12px 0 6px", t);
const descCss = 'font-size:13.5px;color:var(--mut,#757575);line-height:1.6';
const inputCss = "width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dt,#d9d9d9);border-radius:12px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
const btnCss = 'padding:12px 0;text-align:center;background:var(--ink,#0a0a0a);color:var(--inv,#fff);border-radius:100px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px';
const btnGhostCss = 'padding:11px 0;text-align:center;border:1px solid var(--dt,#d9d9d9);border-radius:100px;font-size:13.5px;font-weight:600;cursor:pointer;margin-top:9px';

// ---- small formatters --------------------------------------------------------
const trimNum = (n) => String(+Number(n || 0).toFixed(6));
const shortAddr = (a) => {
  const s = String(a || '');
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
};
const shortTx = (tx) => {
  const s = String(tx || '');
  return s.length > 12 ? `${s.slice(0, 10)}…` : (s || '—');
};
function initialsFrom(s) {
  const v = String(s || '').replace(/^@/, '').replace(/^0x/i, '');
  return (v.slice(0, 2) || '··').toUpperCase();
}

// ---- balances ----------------------------------------------------------------
const usdcBal = (ctx) => Number(ctx.me()?.balances?.USDC || 0);
function availNum(ctx) {
  const f = FROMS[selectedIdx];
  if (f.key === 'usdc') return usdcBal(ctx);
  return Number(chainBal[f.chain] ?? 0);
}
function availText(ctx) {
  const f = FROMS[selectedIdx];
  if (f.key === 'usdc') return `${ctx.fmt.usd(usdcBal(ctx))} available`;
  if (!ctx.wallet.isUnlocked()) return 'WALLET LOCKED';
  const b = chainBal[f.chain];
  if (b == null) return `— ${f.sym} available`;
  return `${trimNum(b)} ${f.sym} available`;
}
async function refreshChainBalances(ctx) {
  if (!ctx.wallet.isUnlocked()) { chainBal = {}; return; }
  try { chainBal = (await ctx.wallet.chainBalances()) || {}; }
  catch { chainBal = {}; }
}

// ---- FROM / amount / fee rendering ------------------------------------------
function updateFrom(root, ctx) {
  const f = FROMS[selectedIdx];
  const dot = ctx.slot(root, 'transfer.fromDot');
  if (dot) dot.style.background = f.dot;
  const name = ctx.slot(root, 'transfer.fromName');
  if (name) name.textContent = f.name;
  const av = ctx.slot(root, 'transfer.fromAvail');
  if (av) av.textContent = availText(ctx);
}

let amountUsdToken = 0; // drops out-of-order quote renders (rapid typing / source cycling)
async function updateAmountUsd(root, ctx) {
  const f = FROMS[selectedIdx];
  const amtEl = ctx.slot(root, 'transfer.amount');
  const out = ctx.slot(root, 'transfer.amountUsd');
  if (!out) return;
  const amt = Number(amtEl?.value || 0);
  if (f.key === 'usdc') { amountUsdToken++; out.textContent = ctx.fmt.usd2(amt); return; }
  const token = ++amountUsdToken;
  out.textContent = '≈ —'; // neutral while the live quote loads
  const p = await getPrices(); // null when no live quote → usdAt renders '—'
  if (token !== amountUsdToken) return;
  out.textContent = '≈ ' + usdAt(p, f.sym, amt);
}

function styleChips(root, ctx) {
  const chips = [
    ['eco', ctx.slot(root, 'transfer.chipEco')],
    ['std', ctx.slot(root, 'transfer.chipStd')],
    ['pri', ctx.slot(root, 'transfer.chipPri')],
  ];
  for (const [fee, chip] of chips) {
    if (!chip) continue;
    const active = fee === selectedFee;
    chip.style.border = active ? '1px solid var(--ink,#0a0a0a)' : '1px dotted var(--dt2,#c6c6c6)';
    chip.style.color = active ? 'var(--ink,#0a0a0a)' : 'var(--mut,#757575)';
    chip.style.fontWeight = active ? '600' : '400';
    const sub = chip.querySelector('span');
    if (sub) sub.style.color = active ? 'var(--mut,#757575)' : 'var(--fnt,#a3a3a3)';
  }
}

async function loadBtcFees(ctx) {
  if (btcFees) return btcFees;
  const base = `https://mempool.space${ctx.wallet.IS_MAINNET ? '' : '/testnet'}/api`;
  try {
    const r = await fetch(`${base}/v1/fees/recommended`);
    if (!r.ok) throw new Error(`fee feed ${r.status}`);
    btcFees = await r.json();
  } catch { btcFees = null; } // no live estimate → FEE UNAVAILABLE, never invented numbers
  return btcFees;
}

let feeToken = 0; // drops out-of-order fee renders (rapid source cycling mid-fetch)
async function updateFee(root, ctx) {
  const token = ++feeToken;
  const f = FROMS[selectedIdx];

  // ECO/STANDARD/PRIORITY chips map to mempool.space BTC fee tiers — they mean
  // nothing for the internal USDC ledger or ETH gas, so hide the grid there.
  const chips = ctx.slot(root, 'transfer.feeChips');
  if (chips) chips.style.display = f.key === 'btc' ? '' : 'none';

  const lab = ctx.slot(root, 'transfer.feeLabel');
  const val = ctx.slot(root, 'transfer.feeValue');
  const arr = ctx.slot(root, 'transfer.arrivesValue');
  if (!lab || !val || !arr) return;

  if (f.key === 'usdc') {
    lab.textContent = 'FEE (INTERNAL)';
    val.textContent = 'FREE';
    arr.textContent = 'INSTANT · LEDGER';
    return;
  }
  if (f.key === 'eth') {
    const ethNet = ctx.wallet.CHAINS[ctx.wallet.ETH_CHAIN].net;
    lab.textContent = 'FEE (GAS)';
    val.textContent = `GAS ~21000 · ${ethNet}`;
    arr.textContent = `~30 SEC · ${ethNet}`;
    return;
  }
  // btc: mempool recommended fees, per selected chip.
  const names = { eco: 'ECONOMY', std: 'STANDARD', pri: 'PRIORITY' };
  const mins = { eco: '~40 MIN', std: '~10 MIN', pri: '~2 MIN' };
  const field = { eco: 'economyFee', std: 'halfHourFee', pri: 'fastestFee' }[selectedFee];
  lab.textContent = `FEE (${names[selectedFee]})`;
  arr.textContent = mins[selectedFee];
  val.textContent = '…';
  let rate = null;
  try {
    const fees = await loadBtcFees(ctx);
    const n = Number(fees?.[field]);
    if (Number.isFinite(n) && n > 0) rate = Math.max(1, Math.round(n));
  } catch { /* fall through to the unavailable state */ }
  if (token !== feeToken) return;
  val.textContent = rate != null ? `${rate} sat/vB` : 'FEE UNAVAILABLE';
  arr.textContent = rate != null ? mins[selectedFee] : '—';
}

// ---- recent recipients -------------------------------------------------------
function amtLabel(t, ctx) {
  const cur = t.currency || 'USDC';
  const n = cur === 'USDC' ? ctx.fmt.num(t.amount) : trimNum(t.amount);
  return `${n} ${cur}`;
}

async function fillRecents(root, ctx) {
  let transfers;
  try { ({ transfers } = await ctx.api.get('/api/transfers')); }
  catch (e) { ctx.errToast(e); return; }

  const L = ctx.list(root, 'transfer.recents');
  if (!L) return;
  L.clear();

  const rows = (transfers || []).slice(0, 5);
  if (!rows.length) {
    const r = L.add();
    ctx.slot(r, 'transfer.recent.initials').textContent = '';
    const name = ctx.slot(r, 'transfer.recent.name');
    name.textContent = 'No transfers yet';
    name.style.color = 'var(--mut,#757575)';
    name.style.fontWeight = '400';
    ctx.slot(r, 'transfer.recent.sub').textContent = '';
    r.style.cursor = 'default';
    return;
  }

  for (const t of rows) {
    const r = L.add();
    const internal = t.chain === 'internal';
    const cp = t.counterparty;
    ctx.slot(r, 'transfer.recent.initials').textContent = initialsFrom(internal ? cp : t.toAddress);
    ctx.slot(r, 'transfer.recent.name').textContent = internal ? `@${cp}` : shortAddr(t.toAddress);
    ctx.slot(r, 'transfer.recent.sub').textContent = `LAST: ${amtLabel(t, ctx)} · ${ctx.fmt.ago(t.createdAt)}`;

    const handler = () => {
      if (internal) {
        const toEl = ctx.slot(root, 'transfer.to');
        if (toEl) { toEl.value = `@${cp}`; toEl.focus(); }
      } else if (t.txid && ctx.wallet.CHAINS[t.chain]) {
        window.open(ctx.wallet.CHAINS[t.chain].explorer(t.txid), '_blank');
      }
    };
    r.addEventListener('click', handler);
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  }
}

// ---- wallet unlock modal -----------------------------------------------------
function openUnlock(ctx, onDone) {
  const handle = ctx.me()?.user?.handle || '';
  const backup = ctx.wallet.deviceBackup(handle);
  const m = ctx.buildModal('UNLOCK YOUR WALLET', 'key');

  if (backup) {
    m.body.appendChild(el('div', descCss,
      'Enter your device backup passphrase to unlock your on-chain keys. They never leave this device.'));
    m.body.appendChild(monoLabel('BACKUP PASSPHRASE'));
    const pass = el('input', inputCss);
    pass.type = 'password';
    pass.placeholder = 'backup passphrase';
    m.body.appendChild(pass);
    const btn = el('div', btnCss, 'Unlock wallet');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.addEventListener('click', async () => {
      try {
        await ctx.wallet.unlockFromDevice(handle, pass.value);
        m.close();
        await onDone();
      } catch (e) { ctx.errToast(e); }
    });
    m.body.appendChild(btn);
    pass.focus();
    return;
  }

  m.body.appendChild(el('div', descCss,
    'No wallet backup on this device. Import your recovery phrase to sign on-chain, or create one on the Wallets screen.'));
  m.body.appendChild(monoLabel('RECOVERY PHRASE (12 WORDS)'));
  const ta = el('textarea', inputCss + ';min-height:70px;resize:vertical');
  ta.placeholder = 'word1 word2 word3 …';
  m.body.appendChild(ta);
  const imp = el('div', btnCss, 'Import & unlock');
  imp.setAttribute('role', 'button');
  imp.setAttribute('tabindex', '0');
  imp.addEventListener('click', async () => {
    try {
      await ctx.wallet.importVault(ta.value);
      m.close();
      await onDone();
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(imp);
  const go = el('div', btnGhostCss, 'Create a wallet on the Wallets screen →');
  go.setAttribute('role', 'button');
  go.setAttribute('tabindex', '0');
  go.addEventListener('click', () => { m.close(); ctx.nav('wallets'); });
  m.body.appendChild(go);
  ta.focus();
}

// ---- review & sign (demoTransfer override) ----------------------------------
async function reviewAndSign(root, ctx) {
  const toEl = ctx.slot(root, 'transfer.to');
  const amtEl = ctx.slot(root, 'transfer.amount');
  const to = (toEl?.value || '').trim();
  const amount = Number(amtEl?.value || 0);
  const f = FROMS[selectedIdx];

  if (!to) return ctx.toast('ENTER A RECIPIENT', 'err');
  if (!(amount > 0)) return ctx.toast('ENTER AN AMOUNT ABOVE ZERO', 'err');

  if (f.key === 'usdc') {
    const handle = to.replace(/^@+/, '');
    try {
      await ctx.api.post('/api/transfers', { to: handle, amount, currency: 'USDC' });
      ctx.toast(`TRANSFER SETTLED · ${ctx.fmt.usd(amount)} TO @${handle}`);
      await ctx.refreshMe();
      updateFrom(root, ctx);
      if (toEl) toEl.value = '';
      if (amtEl) amtEl.value = '';
      updateAmountUsd(root, ctx);
      await fillRecents(root, ctx);
    } catch (e) { ctx.errToast(e); }
    return;
  }

  // on-chain (BTC / ETH)
  const chain = f.chain;
  if (!ctx.wallet.isUnlocked()) {
    openUnlock(ctx, async () => {
      await refreshChainBalances(ctx);
      updateFrom(root, ctx);
      ctx.toast('WALLET UNLOCKED · REVIEW & SIGN AGAIN');
    });
    return;
  }
  try {
    const { txid } = await ctx.wallet.send(chain, to, amount);
    ctx.toast(`BROADCAST · ${shortTx(txid)}`);
    if (amtEl) amtEl.value = '';
    updateAmountUsd(root, ctx);
    await refreshChainBalances(ctx);
    updateFrom(root, ctx);
    await fillRecents(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

// ---- hydrator ----------------------------------------------------------------
export async function hydrate(root, ctx) {
  bindNetwork(ctx); // resolve on-chain source keys/labels from the wallet's active network
  if (!root.dataset.hydrated) {
    const amtEl = ctx.slot(root, 'transfer.amount');
    amtEl?.addEventListener('input', () => updateAmountUsd(root, ctx));

    ctx.setAction('cycleFrom', async () => {
      selectedIdx = (selectedIdx + 1) % FROMS.length;
      updateFrom(root, ctx);
      const f = FROMS[selectedIdx];
      if (f.chain !== 'internal' && ctx.wallet.isUnlocked() && chainBal[f.chain] == null) {
        await refreshChainBalances(ctx);
        updateFrom(root, ctx);
      }
      updateAmountUsd(root, ctx);
      await updateFee(root, ctx);
    });

    ctx.setAction('maxAmount', () => {
      const f = FROMS[selectedIdx];
      if (f.key !== 'usdc' && !ctx.wallet.isUnlocked()) return ctx.toast('UNLOCK YOUR WALLET FIRST', 'err');
      const input = ctx.slot(root, 'transfer.amount');
      if (input) input.value = String(availNum(ctx));
      updateAmountUsd(root, ctx);
    });

    ctx.setAction('pickFee', (chip) => {
      const fee = chip?.dataset?.fee;
      if (fee) selectedFee = fee;
      styleChips(root, ctx);
      updateFee(root, ctx);
    });

    ctx.setAction('demoTransfer', () => reviewAndSign(root, ctx));
    // Recipient QR scanning needs a device-camera capture flow that isn't built
    // yet. This control previously fired the global demoCard action, which toasted
    // the unrelated, fabricated "CARD ADDED TO YOUR VAULT · DEMO". Report honestly.
    ctx.setAction('scanTo', () => ctx.toast('QR SCANNING NOT AVAILABLE YET · PASTE OR TYPE THE ADDRESS'));
    // Token swap has no backend endpoint yet (reported in sharedNeeds). Keep the
    // cross-sell card but stop advertising a working "DEMO" swap.
    ctx.setAction('openSwap', () => ctx.toast('TOKEN SWAP NOT AVAILABLE YET'));

    root.dataset.hydrated = '1';
  }

  const seq = (root.__transferSeq = (root.__transferSeq || 0) + 1);
  try { await ctx.refreshMe(); } catch { /* keep cached me */ }
  if (root.__transferSeq !== seq) return;

  updateFrom(root, ctx);
  styleChips(root, ctx);
  updateAmountUsd(root, ctx);
  await updateFee(root, ctx);
  await fillRecents(root, ctx);

  if (ctx.wallet.isUnlocked()) {
    await refreshChainBalances(ctx);
    if (root.__transferSeq !== seq) return;
    updateFrom(root, ctx);
  }
}
