/* OsmoBank SPA runtime.
 * Behavior follows the logic spec embedded in "OsmoBank App.dc.html"
 * (screens, theme persistence, toasts, invest modal, auth-mode routing),
 * plus hash routing (#/screen) so deep links and the back button work. */
(() => {
  'use strict';

  const SCREENS = [
    'home', 'login', 'signup', 'dash', 'wallets', 'transfer', 'cards',
    'ventures', 'edge', 'reports', 'goals', 'gov', 'fund', 'admin',
  ];
  const FLAG = {
    home: 'isHome', login: 'isLogin', signup: 'isSignup', dash: 'isDash',
    wallets: 'isWallets', transfer: 'isTransfer', cards: 'isCards',
    ventures: 'isVentures', edge: 'isEdge', reports: 'isReports',
    goals: 'isGoals', gov: 'isGov', fund: 'isFund', admin: 'isAdmin',
  };
  const VENTURES = {
    invHelios: ['Helios Grid', '12.4'],
    invFerrymill: ['Ferrymill Robotics', '9.2'],
    invAtlas: ['Atlas Dry Ports', '7.8'],
    invNova: ['Nova Reef', '11.1'],
    invKite: ['Kite Mesh', '8.6'],
    invMeridian: ['Meridian Water', '10.2'],
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  const state = {
    screen: 'home',
    dark: store.get('ob_dark') === '1',
    investName: null,
    investApy: null,
    toast: null,
    authMode: 'member',
  };

  const ifEls = Array.from(document.querySelectorAll('[data-if]'));
  const textEls = Array.from(document.querySelectorAll('[data-text]'));
  const toastWrap = document.querySelector('[data-if="toastOn"]');
  if (toastWrap) { toastWrap.setAttribute('role', 'status'); toastWrap.setAttribute('aria-live', 'polite'); }

  function render() {
    const flags = {
      investOpen: !!state.investName,
      toastOn: !!state.toast,
      authMember: state.authMode === 'member',
      authAdmin: state.authMode === 'admin',
    };
    for (const s of SCREENS) flags[FLAG[s]] = state.screen === s;

    const texts = {
      themeLabel: state.dark ? 'LIGHT' : 'DARK',
      toast: state.toast || '',
      investName: state.investName || '',
      investApy: state.investApy || '',
    };

    document.documentElement.classList.toggle('ob-dark', state.dark);
    document.body.style.background = 'var(--bg,#f4f4f4)';
    for (const el of ifEls) el.style.display = flags[el.dataset.if] ? 'contents' : 'none';
    for (const el of textEls) el.textContent = texts[el.dataset.text];
  }

  function applyScreen(s) {
    state.screen = s;
    state.investName = state.investApy = null;
    store.set('ob_screen', s);
    window.scrollTo(0, 0);
    render();
  }

  function nav(s) {
    if (routeFromHash() === s) applyScreen(s);
    else location.hash = '#/' + s; // hashchange handler applies it
  }

  function routeFromHash() {
    const m = /^#\/(\w+)$/.exec(location.hash);
    return m && SCREENS.includes(m[1]) ? m[1] : null;
  }

  window.addEventListener('hashchange', () => {
    const s = routeFromHash();
    // applyScreen even when s === state.screen: nav() to the current screen must
    // still scroll to top / close the modal (e.g. logo click while hash is #rails)
    if (s) applyScreen(s);
    // non-route hashes (#rails, #ventures, #dao) keep native anchor scrolling
  });

  let toastTimer;
  function showToast(msg) {
    clearTimeout(toastTimer);
    state.toast = msg;
    render();
    toastTimer = setTimeout(() => { state.toast = null; render(); }, 2600);
  }

  function openInvest(name, apy) {
    state.investName = name;
    state.investApy = apy;
    render();
  }
  function closeInvest() {
    state.investName = state.investApy = null;
    render();
  }

  const actions = {
    toggleTheme() {
      state.dark = !state.dark;
      store.set('ob_dark', state.dark ? '1' : '0');
      render();
    },
    setAuthMember() { state.authMode = 'member'; render(); },
    setAuthAdmin() { state.authMode = 'admin'; render(); },
    submitLogin() {
      nav(state.authMode === 'admin' ? 'admin' : 'dash');
      showToast('WELCOME BACK, AMARA');
    },
    submitSignup() {
      nav('dash');
      showToast('VAULT PROVISIONED · MEMBER #48,202');
    },
    closeInvest,
    confirmInvest() {
      const n = state.investName;
      closeInvest();
      showToast('STAKED IN ' + (n || '').toUpperCase() + ' · DEMO');
    },
    stopClick() {}, // clicks inside the modal card stop here instead of reaching the overlay
    demoTransfer() { showToast('TRANSFER SIGNED + BROADCAST · DEMO'); },
    demoVote() { showToast('VOTE CAST WITH 84,300 OSM · DEMO'); },
    demoExport() { showToast('REPORT EXPORTED · CSV + PDF · DEMO'); },
    demoImport() { showToast('STATEMENT IMPORTED · 214 ROWS · DEMO'); },
    demoCard() { showToast('CARD ADDED TO YOUR VAULT · DEMO'); },
    demoGift() { showToast('GIFT CARD PURCHASED · DEMO'); },
    demoGoal() { showToast('GOAL CREATED · DEMO'); },
    demoRef() { showToast('REFERRAL LINK COPIED · OSMO.MONEY/R/AMARA'); },
    demoContribute() { showToast('CONTRIBUTION PLEDGED · DEMO'); },
    demoApprove() { showToast('VENTURE APPROVED FOR LISTING · DEMO'); },
    demoPayout() { showToast('DIVIDEND BATCH QUEUED · DEMO'); },
  };
  for (const s of SCREENS) {
    actions['go' + s.charAt(0).toUpperCase() + s.slice(1)] = () => nav(s);
  }
  for (const [action, [name, apy]] of Object.entries(VENTURES)) {
    actions[action] = () => openInvest(name, apy);
  }

  function runAction(el) {
    const fn = actions[el.dataset.action];
    if (fn) fn();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) runAction(el);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.investName) { closeInvest(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element) {
      const el = e.target.closest('[data-action]');
      if (el && el === e.target) { e.preventDefault(); runAction(el); }
    }
  });

  // Initial screen: deep link (#/x) wins, then last visited, then home.
  const stored = store.get('ob_screen');
  state.screen = routeFromHash() || (SCREENS.includes(stored) ? stored : 'home');
  render();
})();
