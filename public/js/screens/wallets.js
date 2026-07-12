/* Wallets screen hydrator.
 * Wires the client wallet (public/js/wallet.js) + GET /api/wallets so a member
 * can create / import / backup / restore a self-custodial vault and see
 * balances / receive addresses.
 *
 *  - Bitcoin (btc-testnet) + Ethereum (eth-sepolia) cards fill from the unlocked
 *    device vault (addresses + live testnet balances); LOCKED otherwise.
 *  - OSM + USD Coin cards fill from the ledger balances in /api/me.
 *  - Solana card is fully static (we do not manage Solana keys).
 *  - RECEIVE panel + per-card QR icons render locally-generated QR (the only
 *    innerHTML exception). Everything else fills via textContent / createElement. */

// On-chain USD reference rates (display only).
const BTC = 60684;
const ETH = 3530;
const OSM = 0.4182;

// Module (closure) state — persists across screen re-activations.
let recvChain = 'btc-testnet';   // which chain the RECEIVE panel shows
let heldMnemonic = null;         // captured on create/import/unlock — for Reveal

// ---- design-styled element helpers (mirror app.js / transfer.js) ------------
const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const monoLabel = (t) => el('div', "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575);margin:12px 0 6px", t);
const descCss = 'font-size:13.5px;color:var(--mut,#757575);line-height:1.6';
const warnCss = 'font-size:13.5px;color:var(--red,#c47b10);line-height:1.6';
const inputCss = "width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dt,#d9d9d9);border-radius:12px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
const taCss = inputCss + ';min-height:84px;resize:vertical';
const btnCss = 'padding:12px 0;text-align:center;background:var(--ink,#0a0a0a);color:var(--inv,#fff);border-radius:100px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px';
const pillCss = "display:flex;align-items:center;gap:6px;padding:9px 16px;border:1px solid var(--dt,#d9d9d9);border-radius:100px;font-size:13px;font-weight:600;cursor:pointer;background:var(--sf,#fff);color:var(--ink,#0a0a0a)";

// ---- small formatters --------------------------------------------------------
const shortAddr = (a) => {
  const s = String(a || '');
  return s.length > 14 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s;
};

function pill(label, icon, onClick) {
  const b = el('div', pillCss);
  b.setAttribute('role', 'button');
  b.setAttribute('tabindex', '0');
  b.append(el('span', "font-family:'Material Symbols Sharp';font-size:16px;line-height:1", icon), label);
  b.addEventListener('click', onClick);
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  });
  return b;
}

// ---- recovery-phrase grid modal (mirrors app.js provisionWalletFlow) --------
function showPhraseModal(ctx, mnemonic) {
  const m = ctx.buildModal('YOUR RECOVERY PHRASE', 'key');
  m.body.appendChild(el('div', descCss,
    'Write these 12 words down in order. They are the only way to restore your wallet.'));
  const grid = el('div', 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:14px');
  String(mnemonic).trim().split(/\s+/).forEach((w, i) => {
    const cell = el('div', "border:1px dotted var(--dt2,#c6c6c6);border-radius:8px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:12.5px");
    cell.append(el('span', 'color:var(--fnt,#a3a3a3);margin-right:6px', String(i + 1)), w);
    grid.appendChild(cell);
  });
  m.body.appendChild(grid);
  const done = el('div', btnCss, 'Done');
  done.addEventListener('click', m.close);
  m.body.appendChild(done);
}

// ---- create / unlock / import flows -----------------------------------------
async function createVaultFlow(root, ctx) {
  const handle = ctx.me()?.user?.handle;
  const m = ctx.buildModal('PROVISIONING YOUR VAULT', 'key');
  m.body.appendChild(el('div', descCss,
    'Generating your keys on this device… they are never sent to OsmoBank.'));
  let v;
  try { v = await ctx.wallet.createVault(); }
  catch (e) { m.close(); return ctx.errToast(e); }
  heldMnemonic = v.mnemonic;

  m.body.textContent = '';
  m.body.appendChild(el('div', "font-family:'Doto',monospace;font-weight:900;font-size:22px;letter-spacing:.02em", 'YOUR RECOVERY PHRASE'));
  m.body.appendChild(el('div', 'font-size:13px;color:var(--mut,#757575);margin-top:6px;line-height:1.6',
    'Shown once. Write these 12 words down in order — they are the only way to restore your wallet.'));
  const grid = el('div', 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:14px');
  v.mnemonic.split(' ').forEach((w, i) => {
    const cell = el('div', "border:1px dotted var(--dt2,#c6c6c6);border-radius:8px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:12.5px");
    cell.append(el('span', 'color:var(--fnt,#a3a3a3);margin-right:6px', String(i + 1)), w);
    grid.appendChild(cell);
  });
  m.body.appendChild(grid);
  m.body.appendChild(el('div', 'display:flex;gap:8px;margin-top:10px;font-size:12px;color:var(--mut,#757575)',
    `BTC ${v.btcAddress.slice(0, 12)}… · ETH ${v.ethAddress.slice(0, 10)}… · TESTNET`));

  m.body.appendChild(monoLabel('OPTIONAL — KEEP AN ENCRYPTED COPY ON THIS DEVICE'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'backup passphrase (8+ chars, blank to skip)';
  m.body.appendChild(pass);

  const done = el('div', btnCss, 'I saved my phrase — open my vault');
  done.setAttribute('role', 'button');
  done.setAttribute('tabindex', '0');
  done.addEventListener('click', async () => {
    try {
      if (pass.value) await ctx.wallet.saveOnDevice(handle, pass.value);
      m.close();
      ctx.toast('VAULT PROVISIONED');
      await refill(root, ctx);
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(done);
}

function unlockFlow(root, ctx) {
  const handle = ctx.me()?.user?.handle || '';
  const m = ctx.buildModal('UNLOCK YOUR VAULT', 'lock');
  m.body.appendChild(el('div', descCss,
    'Enter your device backup passphrase to unlock your on-chain keys. They never leave this device.'));
  m.body.appendChild(monoLabel('BACKUP PASSPHRASE'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'backup passphrase';
  m.body.appendChild(pass);
  const go = el('div', btnCss, 'Unlock wallet');
  go.setAttribute('role', 'button');
  go.setAttribute('tabindex', '0');
  go.addEventListener('click', async () => {
    try {
      const v = await ctx.wallet.unlockFromDevice(handle, pass.value);
      heldMnemonic = v.mnemonic;
      m.close();
      ctx.toast('WALLET UNLOCKED');
      await refill(root, ctx);
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(go);
  pass.focus();
}

function importFlow(root, ctx) {
  const handle = ctx.me()?.user?.handle || '';
  const m = ctx.buildModal('IMPORT A WALLET', 'upload');
  m.body.appendChild(el('div', descCss,
    'Paste your 12- or 24-word recovery phrase. Your keys are derived on this device and never sent to OsmoBank.'));
  m.body.appendChild(monoLabel('RECOVERY PHRASE'));
  const ta = el('textarea', taCss);
  ta.placeholder = 'word1 word2 word3 …';
  m.body.appendChild(ta);
  m.body.appendChild(monoLabel('OPTIONAL — KEEP AN ENCRYPTED COPY ON THIS DEVICE'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'backup passphrase (8+ chars, blank to skip)';
  m.body.appendChild(pass);
  const go = el('div', btnCss, 'Import wallet');
  go.setAttribute('role', 'button');
  go.setAttribute('tabindex', '0');
  go.addEventListener('click', async () => {
    try {
      const v = await ctx.wallet.importVault(ta.value);
      heldMnemonic = v.mnemonic;
      if (pass.value) await ctx.wallet.saveOnDevice(handle, pass.value);
      m.close();
      ctx.toast('WALLET IMPORTED');
      await refill(root, ctx);
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(go);
  ta.focus();
}

function newWalletFlow(root, ctx) {
  if (ctx.wallet.isUnlocked()) return ctx.toast('WALLET ALREADY UNLOCKED ON THIS DEVICE');
  const handle = ctx.me()?.user?.handle;
  if (handle && ctx.wallet.deviceBackup(handle)) return unlockFlow(root, ctx);
  return createVaultFlow(root, ctx);
}

// ---- backup / restore / reveal / lock ---------------------------------------
function downloadBackupFlow(root, ctx) {
  if (!ctx.wallet.isUnlocked()) return ctx.toast('UNLOCK YOUR WALLET FIRST', 'err');
  const m = ctx.buildModal('DOWNLOAD ENCRYPTED BACKUP', 'download');
  m.body.appendChild(el('div', descCss,
    'Your recovery phrase is encrypted with this passphrase before it leaves memory. Keep both safe.'));
  m.body.appendChild(monoLabel('BACKUP PASSPHRASE (8+ CHARS)'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'backup passphrase';
  m.body.appendChild(pass);
  const go = el('div', btnCss, 'Download backup');
  go.setAttribute('role', 'button');
  go.setAttribute('tabindex', '0');
  go.addEventListener('click', async () => {
    try {
      await ctx.wallet.downloadBackup(pass.value);
      m.close();
      ctx.toast('ENCRYPTED BACKUP DOWNLOADED');
    } catch (e) { ctx.errToast(e); }
  });
  m.body.appendChild(go);
  pass.focus();
}

function restoreFileFlow(root, ctx) {
  const handle = ctx.me()?.user?.handle || '';
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.style.display = 'none';
  inp.addEventListener('change', () => {
    const file = inp.files && inp.files[0];
    document.body.removeChild(inp);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let backup;
      try { backup = JSON.parse(String(reader.result)); }
      catch { return ctx.errToast(new Error('That file is not valid JSON.')); }

      const m = ctx.buildModal('RESTORE FROM BACKUP FILE', 'restore');
      m.body.appendChild(el('div', descCss,
        'Enter the passphrase this backup was encrypted with. The phrase is decrypted only on this device.'));
      m.body.appendChild(monoLabel('BACKUP PASSPHRASE'));
      const pass = el('input', inputCss);
      pass.type = 'password';
      pass.placeholder = 'backup passphrase';
      m.body.appendChild(pass);
      m.body.appendChild(monoLabel('OPTIONAL — KEEP AN ENCRYPTED COPY ON THIS DEVICE'));
      const save = el('input', inputCss);
      save.type = 'password';
      save.placeholder = 'device passphrase (blank to skip)';
      m.body.appendChild(save);
      const go = el('div', btnCss, 'Restore wallet');
      go.setAttribute('role', 'button');
      go.setAttribute('tabindex', '0');
      go.addEventListener('click', async () => {
        try {
          const mnemonic = await ctx.wallet.decryptBackup(backup, pass.value);
          const v = await ctx.wallet.importVault(mnemonic);
          heldMnemonic = v.mnemonic;
          if (save.value) await ctx.wallet.saveOnDevice(handle, save.value);
          m.close();
          ctx.toast('WALLET RESTORED');
          await refill(root, ctx);
        } catch (e) { ctx.errToast(e); }
      });
      m.body.appendChild(go);
      pass.focus();
    };
    reader.readAsText(file);
  });
  document.body.appendChild(inp);
  inp.click();
}

function revealFlow(root, ctx) {
  if (!ctx.wallet.isUnlocked()) return ctx.toast('UNLOCK YOUR WALLET FIRST', 'err');
  const m = ctx.buildModal('REVEAL RECOVERY PHRASE', 'warning');
  m.body.appendChild(el('div', warnCss,
    'Anyone who sees these 12 words controls your funds. Make sure no one is watching your screen.'));
  const go = el('div', btnCss, 'I understand — reveal my phrase');
  go.setAttribute('role', 'button');
  go.setAttribute('tabindex', '0');
  go.addEventListener('click', async () => {
    if (heldMnemonic) { m.close(); return showPhraseModal(ctx, heldMnemonic); }
    const backup = ctx.wallet.deviceBackup(ctx.me()?.user?.handle);
    if (!backup) { m.close(); return ctx.toast('RE-IMPORT YOUR WALLET TO REVEAL THE PHRASE', 'err'); }
    m.body.textContent = '';
    m.body.appendChild(el('div', warnCss, 'Confirm with your device backup passphrase to reveal the phrase.'));
    m.body.appendChild(monoLabel('BACKUP PASSPHRASE'));
    const pass = el('input', inputCss);
    pass.type = 'password';
    m.body.appendChild(pass);
    const go2 = el('div', btnCss, 'Reveal phrase');
    go2.setAttribute('role', 'button');
    go2.setAttribute('tabindex', '0');
    go2.addEventListener('click', async () => {
      try {
        const mn = await ctx.wallet.decryptBackup(backup, pass.value);
        heldMnemonic = mn;
        m.close();
        showPhraseModal(ctx, mn);
      } catch (e) { ctx.errToast(e); }
    });
    m.body.appendChild(go2);
    pass.focus();
  });
  m.body.appendChild(go);
}

function lockWallet(root, ctx) {
  ctx.wallet.lockVault();
  heldMnemonic = null;
  ctx.toast('WALLET LOCKED');
  return refill(root, ctx);
}

// ---- receive modal (per-card QR icon) ---------------------------------------
async function receiveModal(ctx, chain) {
  if (!ctx.wallet.isUnlocked()) return ctx.toast('UNLOCK YOUR WALLET FIRST', 'err');
  const cn = ctx.wallet.CHAINS[chain];
  let info;
  try { info = await ctx.wallet.receiveInfo(chain); }
  catch (e) { return ctx.errToast(e); }

  const m = ctx.buildModal(`RECEIVE ${cn.symbol}`, 'qr_code_2');
  const box = el('div', 'width:180px;height:180px;background:#fff;border-radius:12px;padding:12px;margin:2px auto 0;box-sizing:border-box');
  box.innerHTML = info.qrSvg; // locally generated — allowed innerHTML exception
  const svg = box.querySelector('svg');
  if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block'; }
  m.body.appendChild(box);
  m.body.appendChild(monoLabel(`YOUR ${cn.name.toUpperCase()} ADDRESS · ${cn.net}`));
  m.body.appendChild(el('div',
    "font-family:'IBM Plex Mono',monospace;font-size:12.5px;word-break:break-all;color:var(--ink,#0a0a0a)",
    info.address));
  const copy = el('div', btnCss, 'Copy address');
  copy.setAttribute('role', 'button');
  copy.setAttribute('tabindex', '0');
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(info.address).catch(() => {});
    ctx.toast('ADDRESS COPIED');
  });
  m.body.appendChild(copy);
}

// ---- clipboard / share helpers ----------------------------------------------
function copyChainAddress(ctx, chain) {
  const a = ctx.wallet.isUnlocked() ? ctx.wallet.addresses()?.[chain] : null;
  if (!a) return ctx.toast('UNLOCK YOUR WALLET FIRST', 'err');
  navigator.clipboard?.writeText(a).catch(() => {});
  ctx.toast('ADDRESS COPIED');
}

// ---- chain-card fills --------------------------------------------------------
function setSub(sub, usdText, chgText) {
  sub.textContent = '';
  sub.append(document.createTextNode(`${usdText} · `));
  const g = el('span', 'color:var(--grn,#17a562)', chgText);
  sub.append(g);
}

function fillChainCardLocked(root, ctx, prefix, tag) {
  ctx.slot(root, `wallets.${prefix}.bal`).textContent = 'LOCKED';
  ctx.slot(root, `wallets.${prefix}.sub`).textContent = '— —';
  ctx.slot(root, `wallets.${prefix}.addr`).textContent = 'unlock to view';
  ctx.slot(root, `wallets.${prefix}.tag`).textContent = tag;
}

function fillChainCardAddress(root, ctx, prefix, address, tag) {
  ctx.slot(root, `wallets.${prefix}.addr`).textContent = shortAddr(address) || 'unlock to view';
  ctx.slot(root, `wallets.${prefix}.tag`).textContent = tag;
}

// ---- receive panel -----------------------------------------------------------
function styleReceiveChips(root, ctx) {
  const base = "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.1em;padding:5px 12px;border-radius:100px;border:1px solid color-mix(in srgb,var(--inv,#fff) 30%,transparent);cursor:pointer";
  const active = ';background:var(--inv,#fff);color:var(--ink,#0a0a0a)';
  const idle = ';background:transparent;color:var(--inv,#fff)';
  const b = ctx.slot(root, 'wallets.recv.chipBtc');
  const e = ctx.slot(root, 'wallets.recv.chipEth');
  if (b) b.style.cssText = base + (recvChain === 'btc-testnet' ? active : idle);
  if (e) e.style.cssText = base + (recvChain === 'eth-sepolia' ? active : idle);
}

async function fillReceivePanel(root, ctx) {
  const cn = ctx.wallet.CHAINS[recvChain];
  ctx.slot(root, 'wallets.recv.label').textContent = `RECEIVE / ${cn.name.toUpperCase()}`;
  styleReceiveChips(root, ctx);

  const qr = ctx.slot(root, 'wallets.recv.qr');
  const addrEl = ctx.slot(root, 'wallets.recv.addr');

  if (!ctx.wallet.isUnlocked()) {
    addrEl.textContent = 'Unlock your wallet to reveal your receive address';
    if (qr && root.__qrCss != null) {
      qr.style.cssText = root.__qrCss;
      // Restore the decorative placeholder art (cloned once on first hydrate) —
      // no innerHTML, so the only HTML-string sink remains receiveInfo().qrSvg.
      qr.replaceChildren(...(root.__qrKids || []).map((n) => n.cloneNode(true)));
    }
    return;
  }

  const token = (root.__recvToken = (root.__recvToken || 0) + 1);
  let info;
  try { info = await ctx.wallet.receiveInfo(recvChain); }
  catch (e) { return ctx.errToast(e); }
  if (root.__recvToken !== token) return; // panel switched chains mid-await

  addrEl.textContent = info.address;
  if (qr) {
    qr.style.cssText = 'width:100%;height:100%;position:relative;background:transparent';
    qr.innerHTML = info.qrSvg; // locally generated — allowed innerHTML exception
    const svg = qr.querySelector('svg');
    if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block'; }
  }
}

// ---- self-custody status -----------------------------------------------------
function fillRecoveryStatus(root, ctx, backed) {
  const rec = ctx.slot(root, 'wallets.recovery');
  if (!rec) return;
  rec.style.color = backed ? 'var(--grn,#17a562)' : 'var(--red,#c47b10)';
  rec.textContent = '';
  rec.append(
    el('span', "font-family:'Material Symbols Sharp';font-size:15px;line-height:1", backed ? 'check' : 'error'),
    backed ? 'BACKED UP' : 'NOT BACKED UP',
  );
}

function buildCustodyButtons(root, ctx) {
  const box = ctx.slot(root, 'wallets.custodyActions');
  if (!box) return;
  box.textContent = '';
  box.appendChild(pill('Download backup', 'download', () => downloadBackupFlow(root, ctx)));
  box.appendChild(pill('Restore file', 'restore', () => restoreFileFlow(root, ctx)));
  if (ctx.wallet.isUnlocked()) {
    box.appendChild(pill('Reveal phrase', 'visibility', () => revealFlow(root, ctx)));
    box.appendChild(pill('Lock', 'lock', () => lockWallet(root, ctx)));
  }
}

// ---- core data fill (re-run on every activation and after mutations) --------
async function refill(root, ctx) {
  // Guard against overlapping hydrations (screen left + re-entered mid-fetch).
  const seq = (root.__walletsSeq = (root.__walletsSeq || 0) + 1);

  // Re-fetch balances + registered wallets EVERY call (mirrors dash.js) so the
  // subtitle total and OSM/USD Coin cards never show a stale ledger balance.
  let meData = ctx.me();
  let wallets = [];
  try {
    [meData, wallets] = await Promise.all([
      ctx.refreshMe().then((m) => m || ctx.me()), // refreshMe never throws (internal catch)
      ctx.api.get('/api/wallets').then((r) => r?.wallets || []),
    ]);
  } catch (e) { ctx.errToast(e); meData = ctx.me(); }
  if (root.__walletsSeq !== seq) return;
  if (!meData) return; // core guards the route; defensive null-check

  const usdc = Number(meData.balances?.USDC || 0);
  const osm = Number(meData.balances?.OSM || 0);

  // subtitle: <n> ACTIVE · $<USDC+OSM value> TOTAL · KEYS ON YOUR DEVICE
  const activeCount = wallets.length + 2; // on-chain wallets + USDC & OSM ledgers
  const ledgerTotal = usdc + osm * OSM;
  ctx.slot(root, 'wallets.subtitle').textContent =
    `${activeCount} ACTIVE · ${ctx.fmt.usd2(ledgerTotal)} TOTAL · KEYS ON YOUR DEVICE`;

  // OSM card (ledger governance token)
  ctx.slot(root, 'wallets.osm.bal').textContent = ctx.fmt.num(osm);
  const osmSub = ctx.slot(root, 'wallets.osm.sub');
  osmSub.textContent = '';
  osmSub.append(document.createTextNode(`${ctx.fmt.usd(osm * OSM)} · `));
  osmSub.append(el('span', 'color:var(--grn,#17a562)', '+4.6% 24H'));
  osmSub.append(document.createTextNode(' · VOTING POWER'));

  // USD Coin card (ledger spending balance)
  ctx.slot(root, 'wallets.usdc.bal').textContent = ctx.fmt.usd2(usdc).slice(1);
  ctx.slot(root, 'wallets.usdc.sub').textContent = `${ctx.fmt.usd(usdc)} · SPENDING BALANCE`;

  // self-custody status + action pills
  fillRecoveryStatus(root, ctx, !!ctx.wallet.deviceBackup(meData.user?.handle));
  buildCustodyButtons(root, ctx);

  // receive panel (async — QR)
  await fillReceivePanel(root, ctx);
  if (root.__walletsSeq !== seq) return;

  // on-chain cards
  if (!ctx.wallet.isUnlocked()) {
    heldMnemonic = null; // drop any stale phrase once the vault is locked
    fillChainCardLocked(root, ctx, 'btc', 'TESTNET');
    fillChainCardLocked(root, ctx, 'eth', 'SEPOLIA');
    return;
  }

  const addrs = ctx.wallet.addresses() || {};
  // addresses are known instantly; show them while balances load
  fillChainCardAddress(root, ctx, 'btc', addrs['btc-testnet'], 'TESTNET');
  fillChainCardAddress(root, ctx, 'eth', addrs['eth-sepolia'], 'SEPOLIA');
  ctx.slot(root, 'wallets.btc.bal').textContent = '…';
  ctx.slot(root, 'wallets.btc.sub').textContent = '…';
  ctx.slot(root, 'wallets.eth.bal').textContent = '…';
  ctx.slot(root, 'wallets.eth.sub').textContent = '…';

  let chains = null;
  try { chains = await ctx.wallet.chainBalances(); }
  catch { chains = null; }
  if (root.__walletsSeq !== seq) return;

  const btc = Number(chains?.['btc-testnet'] ?? 0);
  const eth = Number(chains?.['eth-sepolia'] ?? 0);
  ctx.slot(root, 'wallets.btc.bal').textContent = btc.toFixed(5);
  setSub(ctx.slot(root, 'wallets.btc.sub'), ctx.fmt.usd(btc * BTC), '+3.1% 24H');
  ctx.slot(root, 'wallets.eth.bal').textContent = eth.toFixed(4);
  setSub(ctx.slot(root, 'wallets.eth.sub'), ctx.fmt.usd(eth * ETH), '+1.8% 24H');
}

// ---- hydrator ----------------------------------------------------------------
export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    // capture the decorative QR art once so we can restore it when locked
    const qr = ctx.slot(root, 'wallets.recv.qr');
    if (qr) {
      root.__qrCss = qr.style.cssText;
      root.__qrKids = Array.from(qr.childNodes).map((n) => n.cloneNode(true));
    }

    ctx.setAction('newWallet', () => newWalletFlow(root, ctx));
    ctx.setAction('importWallet', () => importFlow(root, ctx));
    ctx.setAction('addChain', () => ctx.toast('40+ CHAINS · DEMO'));

    ctx.setAction('qrBtc', () => receiveModal(ctx, 'btc-testnet'));
    ctx.setAction('qrEth', () => receiveModal(ctx, 'eth-sepolia'));
    ctx.setAction('copyBtc', () => copyChainAddress(ctx, 'btc-testnet'));
    ctx.setAction('copyEth', () => copyChainAddress(ctx, 'eth-sepolia'));

    ctx.setAction('recvSetBtc', async () => { recvChain = 'btc-testnet'; await fillReceivePanel(root, ctx); });
    ctx.setAction('recvSetEth', async () => { recvChain = 'eth-sepolia'; await fillReceivePanel(root, ctx); });
    ctx.setAction('recvCopy', () => copyChainAddress(ctx, recvChain));
    ctx.setAction('recvShare', () => {
      const faucet = ctx.wallet.CHAINS[recvChain]?.faucet;
      if (faucet) { window.open(faucet, '_blank'); ctx.toast('OPENING TESTNET FAUCET'); }
      else copyChainAddress(ctx, recvChain);
    });

    root.dataset.hydrated = '1';
  }

  await refill(root, ctx);
}
