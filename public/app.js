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

  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  x.addEventListener('click', close);
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
  return { overlay, card, body, close };
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
    `BTC ${v.btcAddress.slice(0, 12)}… · ETH ${v.ethAddress.slice(0, 10)}… · TESTNET`));

  m.body.appendChild(monoLabel('OPTIONAL — KEEP AN ENCRYPTED COPY ON THIS DEVICE'));
  const pass = el('input', inputCss);
  pass.type = 'password';
  pass.placeholder = 'backup passphrase (8+ chars, blank to skip)';
  m.body.appendChild(pass);

  await new Promise((resolve) => {
    const done = el('div', btnCss, 'I saved my phrase — open my vault');
    done.addEventListener('click', async () => {
      try {
        if (pass.value) await wallet.saveOnDevice(me.user.handle, pass.value);
        m.close();
        resolve();
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
    try {
      const { user } = await api.post('/api/auth/login', { identifier, passphrase });
      await refreshMe();
      if (state.authMode === 'admin' && user.role !== 'admin') {
        toast('THAT ACCOUNT IS NOT AN OPERATOR — OPENING MEMBER VAULT', 'err');
        nav('dash');
      } else {
        nav(state.authMode === 'admin' ? 'admin' : 'dash');
        toast(`WELCOME BACK, ${user.name.split(' ')[0].toUpperCase()}`);
      }
    } catch (e) { errToast(e); }
  },

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
