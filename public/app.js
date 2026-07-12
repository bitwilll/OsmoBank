/* OsmoBank application core.
 * Design behaviors (theme, toasts, routing, invest modal) follow the spec
 * embedded in "OsmoBank App.dc.html"; on top of that: real sessions, guarded
 * routes, per-screen hydrators, client-side wallet, profile management. */
import { api, fmt } from './js/api.js';
import * as wallet from './js/wallet.js';

const SCREENS = ['home', 'login', 'signup', 'dash', 'wallets', 'transfer', 'cards',
  'ventures', 'edge', 'reports', 'goals', 'gov', 'fund', 'admin'];
const FLAG = {
  home: 'isHome', login: 'isLogin', signup: 'isSignup', dash: 'isDash',
  wallets: 'isWallets', transfer: 'isTransfer', cards: 'isCards',
  ventures: 'isVentures', edge: 'isEdge', reports: 'isReports',
  goals: 'isGoals', gov: 'isGov', fund: 'isFund', admin: 'isAdmin',
};
const PUBLIC_SCREENS = ['home', 'login', 'signup', 'fund'];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  screen: 'home',
  dark: store.get('ob_dark') === '1',
  invest: null,           // {name, apy, max, onConfirm}
  toast: null, toastKind: 'ok',
  authMode: 'member',
};
let me = null;            // {user, balances} from /api/me
const overrides = {};     // screen -> {action: fn}
const hydratorCache = {}; // screen -> module | null

// ---- DOM helpers ----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

/** data-list container: first element child is the row template. */
export function list(root, name) {
  const box = root.querySelector(`[data-list="${name}"]`);
  if (!box) return null;
  if (!box.__tpl) {
    box.__tpl = box.firstElementChild.cloneNode(true);
    box.textContent = '';
  }
  return {
    el: box,
    clear: () => { box.textContent = ''; },
    add() {
      const row = box.__tpl.cloneNode(true);
      box.appendChild(row);
      return row;
    },
  };
}

// ---- rendering --------------------------------------------------------------
function render() {
  const flags = {
    investOpen: !!state.invest,
    toastOn: !!state.toast,
    authMember: state.authMode === 'member',
    authAdmin: state.authMode === 'admin',
  };
  for (const s of SCREENS) flags[FLAG[s]] = state.screen === s;

  document.documentElement.classList.toggle('ob-dark', state.dark);
  document.body.style.background = 'var(--bg,#f4f4f4)';

  for (const el of $$('[data-if]')) el.style.display = flags[el.dataset.if] ? 'contents' : 'none';

  const texts = {
    themeLabel: state.dark ? 'LIGHT' : 'DARK',
    toast: state.toast || '',
    investName: state.invest?.name || '',
    investApy: state.invest?.apy || '',
  };
  for (const el of $$('[data-text]')) el.textContent = texts[el.dataset.text];

  const dot = $('[data-slot="toast.dot"]');
  if (dot) dot.style.background = state.toastKind === 'err' ? 'var(--red,#c47b10)' : 'var(--grn,#17a562)';
  const maxEl = $('[data-slot="invest.max"]');
  if (maxEl && state.invest) maxEl.textContent = `MAX ${fmt.usd(state.invest.max)}`;

  const initials = (me?.user?.name || 'A O').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  for (const el of $$('[data-slot="avatarInitials"]')) el.textContent = initials;
}

let toastTimer;
export function toast(msg, kind = 'ok') {
  clearTimeout(toastTimer);
  state.toast = msg;
  state.toastKind = kind;
  render();
  toastTimer = setTimeout(() => { state.toast = null; render(); }, 3200);
}
const errToast = (e) => toast(String(e?.message || e).toUpperCase().slice(0, 90), 'err');

// ---- session ----------------------------------------------------------------
export async function refreshMe() {
  try { me = await api.get('/api/me'); } catch { me = null; }
  render();
  return me;
}

// ---- routing ----------------------------------------------------------------
function guard(screenName) {
  if (PUBLIC_SCREENS.includes(screenName)) return screenName;
  if (!me) { toast('SIGN IN FIRST', 'err'); return 'login'; }
  if (screenName === 'admin' && me.user.role !== 'admin') { toast('OPERATOR ACCESS ONLY', 'err'); return 'dash'; }
  return screenName;
}

async function applyScreen(s) {
  s = guard(s);
  state.screen = s;
  state.invest = null;
  store.set('ob_screen', s);
  window.scrollTo(0, 0);
  render();
  if (location.hash !== '#/' + s) history.replaceState(null, '', '#/' + s);
  await runHydrator(s);
}

export function nav(s) {
  if (routeFromHash() === s) applyScreen(s);
  else location.hash = '#/' + s;
}

const routeFromHash = () => {
  const m = /^#\/(\w+)$/.exec(location.hash);
  return m && SCREENS.includes(m[1]) ? m[1] : null;
};

window.addEventListener('hashchange', () => {
  const s = routeFromHash();
  if (s) applyScreen(s);
});

async function runHydrator(screenName) {
  if (!(screenName in hydratorCache)) {
    hydratorCache[screenName] = await import(`./js/screens/${screenName}.js`).catch(() => null);
  }
  const mod = hydratorCache[screenName];
  const mount = $(`[data-partial="${screenName}"]`);
  if (mod?.hydrate && mount) {
    try { await mod.hydrate(mount, ctx(screenName)); } catch (e) { console.error(`hydrate ${screenName}`, e); }
  }
}

// ---- hydrator context ---------------------------------------------------------
function ctx(screenName) {
  return {
    api, fmt, wallet, nav, toast, errToast, slot, list, refreshMe,
    me: () => me,
    setAction(name, fn) { (overrides[screenName] ??= {})[name] = fn; },
    openInvest(cfg) { state.invest = cfg; render(); $('[data-slot="invest.amount"]').value = ''; },
    closeInvest, buildModal,
  };
}

function closeInvest() { state.invest = null; render(); }

// ---- shared modal builder (design-consistent) -----------------------------------
export function buildModal(title, icon = 'diamond') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(480px,94vw);max-height:88vh;overflow:auto;background:var(--sf,#fff);border:1px solid var(--hr,#e4e4e4);border-radius:22px;padding:26px;color:var(--ink,#0a0a0a)';
  overlay.appendChild(card);

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px';
  const label = document.createElement('div');
  label.style.cssText = "display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575)";
  const ic = document.createElement('span');
  ic.style.cssText = "font-family:'Material Symbols Sharp';font-size:16px;line-height:1";
  ic.textContent = icon;
  label.append(ic, title);
  const x = document.createElement('span');
  x.style.cssText = "font-family:'Material Symbols Sharp';font-size:20px;line-height:1;cursor:pointer;color:var(--mut,#757575)";
  x.textContent = 'close';
  head.append(label, x);
  card.appendChild(head);

  const body = document.createElement('div');
  card.appendChild(body);

  const handle = { onClose: null };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', esc);
    if (handle.onClose) handle.onClose();
  };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  x.addEventListener('click', close);
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
  handle.overlay = overlay; handle.card = card; handle.body = body; handle.close = close;
  return handle; // set handle.onClose to run a callback on ANY dismissal (button/X/ESC/overlay)
}

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

// ---- signup: wallet provisioning ------------------------------------------------
async function provisionWalletFlow() {
  const m = buildModal('PROVISIONING YOUR VAULT', 'key');
  m.body.appendChild(el('div', 'font-size:13.5px;color:var(--mut,#757575);line-height:1.6',
    'Generating your keys on this device… they are never sent to OsmoBank.'));
  let v;
  try {
    v = await wallet.createVault();
  } catch (e) { m.close(); throw e; }

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
    `BTC ${v.btcAddress.slice(0, 12)}… · ETH ${v.ethAddress.slice(0, 10)}… · ${wallet.IS_MAINNET ? 'MAINNET' : 'TESTNET'}`));

  m.body.appendChild(monoLabel('OPTIONAL — KEEP AN ENCRYPTED COPY ON THIS DEVICE'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'backup passphrase (8+ chars, blank to skip)';
  m.body.appendChild(pass);

  await new Promise((resolve) => {
    m.onClose = resolve; // dismissing the modal (X/ESC/overlay) still proceeds to the vault
    const done = el('div', btnCss, 'I saved my phrase — open my vault');
    done.addEventListener('click', async () => {
      try {
        if (pass.value) await wallet.saveOnDevice(me.user.handle, pass.value);
        m.close(); // triggers onClose → resolve
      } catch (e) { errToast(e); }
    });
    m.body.appendChild(done);
  });
}

// ---- profile modal ---------------------------------------------------------------
function openProfile() {
  if (!me) return nav('login');
  const m = buildModal('PROFILE & SECURITY', 'person');
  const u = me.user;

  m.body.appendChild(el('div', "font-family:'Doto',monospace;font-weight:900;font-size:22px", u.name.toUpperCase()));
  m.body.appendChild(el('div', 'font-size:12.5px;color:var(--mut,#757575);margin-top:4px',
    `@${u.handle} · ${u.role.toUpperCase()} · MEMBER #${48195 + u.id}`));

  m.body.appendChild(monoLabel('NAME'));
  const name = el('input', inputCss); name.value = u.name; m.body.appendChild(name);
  m.body.appendChild(monoLabel('EMAIL'));
  const email = el('input', inputCss); email.value = u.email; m.body.appendChild(email);
  const save = el('div', btnCss, 'Save profile');
  save.addEventListener('click', async () => {
    try {
      const r = await api.patch('/api/me', { name: name.value, email: email.value });
      me = { ...me, user: r.user };
      toast('PROFILE UPDATED');
      render();
    } catch (e) { errToast(e); }
  });
  m.body.appendChild(save);

  m.body.appendChild(monoLabel('CHANGE PASSPHRASE'));
  const cur = el('input', inputCss); cur.type = 'password'; cur.placeholder = 'current passphrase';
  const nxt = el('input', inputCss + ';margin-top:8px'); nxt.type = 'password'; nxt.placeholder = 'new passphrase (12+ chars)';
  m.body.append(cur, nxt);
  const change = el('div', btnGhostCss, 'Rotate passphrase');
  change.addEventListener('click', async () => {
    try {
      await api.post('/api/me/passphrase', { current: cur.value, next: nxt.value });
      toast('PASSPHRASE ROTATED · OTHER SESSIONS SIGNED OUT');
      cur.value = nxt.value = '';
    } catch (e) { errToast(e); }
  });
  m.body.appendChild(change);

  m.body.appendChild(monoLabel('SECURITY'));
  api.get('/api/security').then((sec) => {
    const bits = [];
    bits.push(sec.twoFactorEnabled ? '2FA on' : '2FA off');
    bits.push(`${sec.passkeys.length} passkey${sec.passkeys.length === 1 ? '' : 's'}`);
    secStatus.textContent = bits.join(' · ');
  }).catch(() => { secStatus.textContent = ''; });
  const secStatus = el('div', 'font-size:12.5px;color:var(--mut,#757575)', 'Two-factor & passkeys');
  m.body.appendChild(secStatus);
  const secBtn = el('div', btnGhostCss, 'Two-factor & passkeys');
  secBtn.addEventListener('click', () => { m.close(); openSecurity(); });
  m.body.appendChild(secBtn);

  m.body.appendChild(monoLabel('WALLET'));
  m.body.appendChild(el('div', 'font-size:12.5px;color:var(--mut,#757575)',
    wallet.isUnlocked() ? 'Unlocked on this device.' : (wallet.deviceBackup(u.handle) ? 'Encrypted backup on this device — unlock from the Wallets screen.' : 'No wallet on this device — create or import from the Wallets screen.')));
  if (wallet.isUnlocked()) {
    const lock = el('div', btnGhostCss, 'Lock wallet');
    lock.addEventListener('click', () => { wallet.lockVault(); toast('WALLET LOCKED'); m.close(); });
    m.body.appendChild(lock);
  }

  const out = el('div', btnGhostCss + ';border-color:var(--red,#c47b10);color:var(--red,#c47b10)', 'Sign out');
  out.addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => {});
    wallet.lockVault();
    me = null;
    m.close();
    nav('home');
    toast('SIGNED OUT');
  });
  m.body.appendChild(out);
}

// ---- security: 2FA (TOTP) + passkeys (WebAuthn) --------------------------------------
const btnRedGhostCss = 'padding:11px 0;text-align:center;border:1px solid var(--red,#c47b10);color:var(--red,#c47b10);border-radius:100px;font-size:13.5px;font-weight:600;cursor:pointer;margin-top:9px';

async function openSecurity() {
  if (!me) return nav('login');
  const m = buildModal('SECURITY', 'shield');

  async function render() {
    m.body.textContent = '';
    let sec;
    try { sec = await api.get('/api/security'); } catch (e) { return errToast(e); }

    // ── Two-factor ──────────────────────────────────────────────────────────
    m.body.appendChild(monoLabel('TWO-FACTOR AUTHENTICATION'));
    m.body.appendChild(el('div', 'font-size:12.5px;color:var(--mut,#757575);line-height:1.5',
      sec.twoFactorEnabled
        ? 'Enabled. A 6-digit code from your authenticator is required every sign-in.'
        : 'Protect sign-in with a time-based code (Google Authenticator, Authy, 1Password…).'));
    if (sec.twoFactorEnabled) {
      const code = el('input', inputCss + ';margin-top:10px'); code.placeholder = 'current 6-digit code'; code.inputMode = 'numeric';
      m.body.appendChild(code);
      const off = el('div', btnRedGhostCss, 'Disable 2FA');
      off.addEventListener('click', async () => {
        try { await api.post('/api/security/2fa/disable', { code: code.value }); toast('TWO-FACTOR DISABLED'); await render(); }
        catch (e) { errToast(e); }
      });
      m.body.appendChild(off);
    } else {
      const on = el('div', btnCss, 'Enable 2FA');
      on.addEventListener('click', () => enroll2fa(render));
      m.body.appendChild(on);
    }

    // ── Passkeys ────────────────────────────────────────────────────────────
    m.body.appendChild(monoLabel('PASSKEYS'));
    if (!sec.passkeys.length) {
      m.body.appendChild(el('div', 'font-size:12.5px;color:var(--mut,#757575);line-height:1.5',
        'None yet. Add a passkey to sign in with Face ID, Touch ID, or a security key — no passphrase needed.'));
    }
    for (const pk of sec.passkeys) {
      const row = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px dotted var(--dt2,#c6c6c6)');
      row.appendChild(el('div', 'font-size:13px', `${pk.label} · added ${fmt.date(pk.createdAt)}`));
      const rm = el('span', "font-family:'Material Symbols Sharp';font-size:18px;cursor:pointer;color:var(--mut,#757575)", 'delete');
      rm.addEventListener('click', async () => {
        try { await api.del(`/api/security/passkey/${pk.id}`); toast('PASSKEY REMOVED'); await render(); }
        catch (e) { errToast(e); }
      });
      row.appendChild(rm);
      m.body.appendChild(row);
    }
    if (!window.PublicKeyCredential) {
      m.body.appendChild(el('div', 'font-size:11.5px;color:var(--fnt,#a3a3a3);margin-top:8px', 'This browser does not support passkeys.'));
    } else {
      const add = el('div', btnGhostCss, 'Add a passkey');
      add.addEventListener('click', () => addPasskey(render));
      m.body.appendChild(add);
    }
  }
  await render();
}

async function enroll2fa(refresh) {
  const m = buildModal('ENABLE TWO-FACTOR', 'key');
  let setup;
  try { setup = await api.post('/api/security/2fa/setup'); } catch (e) { m.close(); return errToast(e); }
  m.body.appendChild(el('div', 'font-size:13px;color:var(--mut,#757575);line-height:1.6',
    'Scan this with your authenticator app, or enter the key manually. Then type the 6-digit code it shows.'));
  try {
    const L = await import('./vendor/wallet-libs.js');
    const qr = L.qrcode(0, 'M'); qr.addData(setup.otpauthUri); qr.make();
    const box = el('div', 'width:170px;height:170px;margin:14px auto;background:#fff;padding:10px;border-radius:12px;box-sizing:border-box');
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true }); // locally generated
    m.body.appendChild(box);
  } catch { /* QR optional */ }
  m.body.appendChild(el('div', "text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--mut,#757575);word-break:break-all", setup.secret));
  const code = el('input', inputCss + ';margin-top:12px'); code.placeholder = '6-digit code'; code.inputMode = 'numeric';
  m.body.appendChild(code);
  const go = el('div', btnCss, 'Verify & enable');
  go.addEventListener('click', async () => {
    try { await api.post('/api/security/2fa/enable', { code: code.value }); m.close(); toast('TWO-FACTOR ENABLED'); await refresh(); }
    catch (e) { errToast(e); }
  });
  m.body.appendChild(go);
  code.focus();
}

async function addPasskey(refresh) {
  try {
    const { startRegistration } = await import('./vendor/webauthn.js');
    const options = await api.post('/api/security/passkey/register/options');
    const attResp = await startRegistration({ optionsJSON: options });
    await api.post('/api/security/passkey/register/verify', { response: attResp, label: `Passkey · ${new Date().toLocaleDateString()}` });
    toast('PASSKEY ADDED');
    await refresh();
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return; // user cancelled
    errToast(e);
  }
}

async function passkeyLogin(identifier) {
  const { startAuthentication } = await import('./vendor/webauthn.js');
  const options = await api.post('/api/auth/passkey/login/options', identifier ? { identifier } : {});
  const asseResp = await startAuthentication({ optionsJSON: options });
  const { user } = await api.post('/api/auth/passkey/login/verify', { response: asseResp });
  return user;
}

/** Small modal that collects a 6-digit 2FA code, then runs onSubmit(code). */
function promptTwoFactor(onSubmit) {
  const m = buildModal('TWO-FACTOR REQUIRED', 'lock');
  m.body.appendChild(el('div', 'font-size:13px;color:var(--mut,#757575);line-height:1.6',
    'Enter the 6-digit code from your authenticator app.'));
  const code = el('input', inputCss + ';margin-top:12px'); code.placeholder = '000000'; code.inputMode = 'numeric'; code.maxLength = 6;
  m.body.appendChild(code);
  const go = el('div', btnCss, 'Verify');
  const submit = async () => {
    try { await onSubmit(code.value.trim()); m.close(); }
    catch (e) { errToast(e); }
  };
  go.addEventListener('click', submit);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  m.body.appendChild(go);
  code.focus();
}

// ---- global actions ---------------------------------------------------------------
const DEMO_VENTURES = {
  invHelios: ['Helios Grid', '12.4'], invFerrymill: ['Ferrymill Robotics', '9.2'],
  invAtlas: ['Atlas Dry Ports', '7.8'], invNova: ['Nova Reef', '11.1'],
  invKite: ['Kite Mesh', '8.6'], invMeridian: ['Meridian Water', '10.2'],
};

const actions = {
  toggleTheme() {
    state.dark = !state.dark;
    store.set('ob_dark', state.dark ? '1' : '0');
    render();
  },
  setAuthMember() { state.authMode = 'member'; render(); },
  setAuthAdmin() { state.authMode = 'admin'; render(); },

  async submitLogin() {
    const root = $('[data-partial="login"]');
    const identifier = $('input[placeholder="amara@osmo.money"]', root)?.value?.trim();
    const passphrase = $('input[type="password"]', root)?.value;
    if (!identifier || !passphrase) return toast('ENTER YOUR EMAIL/@HANDLE AND PASSPHRASE', 'err');
    const finish = (user) => {
      if (state.authMode === 'admin' && user.role !== 'admin') {
        toast('THAT ACCOUNT IS NOT AN OPERATOR — OPENING MEMBER VAULT', 'err');
        nav('dash');
      } else {
        nav(state.authMode === 'admin' ? 'admin' : 'dash');
        toast(`WELCOME BACK, ${user.name.split(' ')[0].toUpperCase()}`);
      }
    };
    try {
      const { user } = await api.post('/api/auth/login', { identifier, passphrase });
      await refreshMe();
      finish(user);
    } catch (e) {
      if (e.body?.twoFactorRequired) return promptTwoFactor(async (totpCode) => {
        const { user } = await api.post('/api/auth/login', { identifier, passphrase, totpCode });
        await refreshMe();
        finish(user);
      });
      errToast(e);
    }
  },

  async passkeyLogin() {
    if (!window.PublicKeyCredential) return toast('THIS BROWSER DOES NOT SUPPORT PASSKEYS', 'err');
    const root = $('[data-partial="login"]');
    const identifier = $('input[placeholder="amara@osmo.money"]', root)?.value?.trim() || undefined;
    try {
      const user = await passkeyLogin(identifier);
      await refreshMe();
      nav(user.role === 'admin' && state.authMode === 'admin' ? 'admin' : 'dash');
      toast(`WELCOME BACK, ${user.name.split(' ')[0].toUpperCase()}`);
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return;
      errToast(e);
    }
  },
  security: openSecurity,

  async submitSignup() {
    const root = $('[data-partial="signup"]');
    const body = {
      name: $('input[placeholder="Amara Okafor"]', root)?.value?.trim(),
      handle: $('input[placeholder="@amara"]', root)?.value?.trim(),
      email: $('input[placeholder="you@anywhere.earth"]', root)?.value?.trim(),
      passphrase: $('input[type="password"]', root)?.value,
    };
    try {
      await api.post('/api/auth/register', body);
      await refreshMe();
      await provisionWalletFlow();
      nav('dash');
      toast(`VAULT PROVISIONED · MEMBER #${fmt.num(48195 + me.user.id)}`);
    } catch (e) { errToast(e); }
  },

  profile: openProfile,
  closeInvest,
  investMax() {
    const inv = state.invest;
    if (inv) $('[data-slot="invest.amount"]').value = String(inv.max);
  },
  async confirmInvest() {
    const inv = state.invest;
    if (!inv) return;
    const amount = Number($('[data-slot="invest.amount"]').value || 0);
    try {
      await inv.onConfirm(amount);
      closeInvest();
    } catch (e) { errToast(e); }
  },
  stopClick() {},

  demoTransfer: () => toast('TRANSFER SIGNED + BROADCAST · DEMO'),
  demoVote: () => toast('VOTE CAST · DEMO'),
  demoExport: () => { window.open('/api/reports/export', '_blank'); toast('REPORT EXPORTED · CSV'); },
  demoImport: () => toast('STATEMENT IMPORT · DEMO'),
  demoCard: () => toast('CARD ADDED TO YOUR VAULT · DEMO'),
  demoGift: () => toast('GIFT CARD PURCHASED · DEMO'),
  demoGoal: () => toast('GOAL CREATED · DEMO'),
  demoRef() {
    const link = `osmo.money/r/${me?.user?.handle || 'amara'}`;
    navigator.clipboard?.writeText(`https://${link}`).catch(() => {});
    toast(`REFERRAL LINK COPIED · ${link.toUpperCase()}`);
  },
  demoContribute: () => toast('CONTRIBUTION PLEDGED · DEMO'),
  demoApprove: () => toast('VENTURE APPROVED · DEMO'),
  demoPayout: () => toast('DIVIDEND BATCH QUEUED · DEMO'),
};
for (const s of SCREENS) actions['go' + s[0].toUpperCase() + s.slice(1)] = () => nav(s);
for (const [name, [vName, apy]] of Object.entries(DEMO_VENTURES)) {
  actions[name] = () => {
    // fallback when the ventures hydrator hasn't replaced the static cards
    state.invest = {
      name: vName, apy, max: me?.balances?.USDC ?? 0,
      onConfirm: async () => { toast(`STAKED IN ${vName.toUpperCase()} · DEMO`); },
    };
    render();
  };
}

function runAction(elx) {
  const name = elx.dataset.action;
  const fn = overrides[state.screen]?.[name] || actions[name];
  if (fn) fn(elx);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (t) runAction(t);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.invest) { closeInvest(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element) {
    const t = e.target.closest('[data-action]');
    if (t && t === e.target) { e.preventDefault(); runAction(t); }
  }
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
    if (state.screen === 'login') actions.submitLogin();
    else if (state.screen === 'signup' && e.target.closest('[data-partial="signup"]')) actions.submitSignup();
  }
});

// ---- boot -----------------------------------------------------------------------
async function boot() {
  await Promise.all($$('[data-partial]').map(async (mount) => {
    const res = await fetch(`/partials/${mount.dataset.partial}.html`);
    mount.innerHTML = await res.text(); // our own static markup
  }));

  await refreshMe();

  const stored = store.get('ob_screen');
  const initial = routeFromHash() || (SCREENS.includes(stored) ? stored : 'home');
  await applyScreen(initial);
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = 'OsmoBank failed to load — is the server running? (npm start)';
});
