/* Home / landing hydrator.
 *
 * Auth-aware header controls + single-active-session guard:
 *   Not signed in            → Log in + Get started.
 *   Signed in, sole session  → Open dashboard + Sign out.
 *   Signed in, live elsewhere→ Sign out only; the dashboard is withheld and a
 *                              warning banner offers to sign out the other devices.
 *   Liveness comes from me().session.othersLive (see GET /api/me → sessionStatus).
 *
 * Every marketing number on the page is hydrated from a real source:
 *   getPrices()              → ticker BTC/ETH/SOL/USDC (both marquee copies)
 *   GET /api/stats (public)  → members, treasury, dividends, votes, top APY,
 *                              live proposal code, ventures, proposals passed
 *   GET /api/ventures (auth) → venture floor top 3; the section hides on 401
 *   GET /api/fundraiser(auth)→ open-raise banner; hidden on 401/404
 *   mempool.space tip height → footer network line
 * The partial's defaults are neutral ('—', width:0%, hidden sections), so a
 * fabricated figure can never render — not mid-fetch, not on API failure. */

import { getPrices } from '../prices.js';

const show = (elm, on) => { if (elm) elm.style.display = on ? '' : 'none'; };

// Write every element carrying the slot — the ticker marquee duplicates its
// list for the seamless loop, and ctx.slot() only returns the first match.
const setAll = (root, name, text) => {
  for (const n of root.querySelectorAll(`[data-slot="${name}"]`)) n.textContent = text;
};

// Ticker price density: $61,234 above $1k, $37.84 below.
const price = (n) => '$' + Number(n).toLocaleString('en-US', {
  minimumFractionDigits: n >= 1000 ? 0 : 2,
  maximumFractionDigits: n >= 1000 ? 0 : 2,
});

// Compact treasury-style figures: $284.0M / $61.2K / $912.
const usdCompact = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

// Venture-floor sector dots (matches the ventures screen's sector palette).
const SECTOR_DOT = {
  ENERGY: '#f5a623', ROBOTICS: '#38bdd4', LOGISTICS: '#8752f3',
  OCEAN: '#1fb597', DATA: '#627eea', INFRA: '#2775ca', AGRI: '#7cb342',
};

function apply(root, ctx) {
  const me = ctx.me();
  const authed = !!me;
  const othersLive = me?.session?.othersLive || 0;
  const liveElsewhere = authed && othersLive > 0;
  const canDash = authed && !liveElsewhere;      // sole active session

  show(ctx.slot(root, 'home.login'), !authed);
  show(ctx.slot(root, 'home.signup'), !authed);
  show(ctx.slot(root, 'home.dash'), canDash);
  show(ctx.slot(root, 'home.signout'), authed);

  const warn = ctx.slot(root, 'home.sessionWarn');
  if (warn) warn.style.display = liveElsewhere ? 'flex' : 'none';
}

export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    root.dataset.hydrated = '1';
    ctx.setAction('signOutOthers', async () => {
      try {
        const r = await ctx.api.post('/api/auth/logout-all');
        await ctx.refreshMe();               // othersLive should now be 0
        apply(root, ctx);
        const n = r.revoked || 0;
        ctx.toast(`SIGNED OUT ${n} OTHER DEVICE${n === 1 ? '' : 'S'}`);
      } catch (e) { ctx.errToast(e); }
    });
  }

  // Drop stale writes when the screen is left and re-entered mid-fetch.
  const seq = (root.__homeSeq = (root.__homeSeq || 0) + 1);
  const live = () => root.__homeSeq === seq;

  // One fundraiser fetch feeds both the banner and the floor's RAISING badge.
  // 401 (anonymous) and 404 (nothing open) both resolve to null → stay hidden.
  const fundP = ctx.api.get('/api/fundraiser')
    .then((r) => r?.fundraiser || null)
    .catch(() => null);

  // Independent sources: one failing must never block the rest. Each fill
  // degrades to the partial's neutral defaults on error.
  await Promise.all([
    ctx.refreshMe().then(() => { if (live()) apply(root, ctx); }),
    fillTicker(root, live),
    fillStats(root, ctx, live),
    fillVentures(root, ctx, live, fundP),
    fillFundBanner(root, ctx, live, fundP),
    fillBlockTip(root, ctx, live),
  ].map((p) => p.catch((e) => console.error('home hydrate', e))));
}

// ---- ticker marquee (both copies) -------------------------------------------
async function fillTicker(root, live) {
  const p = await getPrices(); // null on failure — markup already shows '—'
  if (!live()) return;
  for (const sym of ['BTC', 'ETH', 'SOL', 'USDC']) {
    const q = p?.[sym];
    setAll(root, `tick.${sym.toLowerCase()}`, q?.usd != null ? price(q.usd) : '—');
  }
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const chg = p?.[sym]?.chg24h;
    for (const n of root.querySelectorAll(`[data-slot="tick.${sym.toLowerCase()}Chg"]`)) {
      if (chg == null) { n.textContent = ''; continue; }
      const up = chg >= 0;
      n.textContent = `${up ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`;
      n.style.color = up ? 'var(--grn,#17a562)' : 'var(--red,#c47b10)';
    }
  }
}

// ---- public aggregates: /api/stats ------------------------------------------
async function fillStats(root, ctx, live) {
  let s;
  try { s = await ctx.api.get('/api/stats'); } catch { return; } // stays '—'
  if (!live() || !s) return;
  const { fmt } = ctx;
  const treasury = usdCompact(s.treasuryUsd);
  const dividends = usdCompact(s.dividendsPaid);
  const members = fmt.num(s.members);

  setAll(root, 'tick.treasury', treasury);
  setAll(root, 'tick.members', members);

  setAll(root, 'hero.coowners', members);
  setAll(root, 'hero.treasury', treasury);
  setAll(root, 'hero.members', members);
  setAll(root, 'hero.dividends', dividends);
  setAll(root, 'hero.liveVotes', fmt.num(s.liveVotes));
  setAll(root, 'hero.liveVotesLabel', s.liveVotes === 1 ? 'LIVE VOTE' : 'LIVE VOTES');
  const dot = ctx.slot(root, 'hero.liveDot');
  if (dot) dot.style.display = s.liveVotes > 0 ? 'inline-block' : 'none';

  setAll(root, 'rails.topApy', s.topApy != null ? `${Number(s.topApy).toFixed(1)}%` : '—');
  const badge = ctx.slot(root, 'rails.propBadge');
  if (badge) {
    setAll(root, 'rails.propCode', s.liveProposalCode || '');
    badge.style.display = s.liveProposalCode ? 'flex' : 'none';
  }

  setAll(root, 'stats.treasury', treasury);
  setAll(root, 'stats.activeVentures', fmt.num(s.activeVentures));
  setAll(root, 'stats.proposalsPassed', fmt.num(s.proposalsPassed));
  setAll(root, 'stats.liveVotes', fmt.num(s.liveVotes));
  setAll(root, 'stats.dividends', dividends);
  setAll(root, 'stats.members', members);

  setAll(root, 'dao.proposalsPassed', fmt.num(s.proposalsPassed));
  setAll(root, 'dao.liveVotes', fmt.num(s.liveVotes));
}

// ---- venture floor: /api/ventures (auth-gated) -------------------------------
async function fillVentures(root, ctx, live, fundP) {
  const section = ctx.slot(root, 'home.venturesSection');
  if (!section) return;
  let ventures;
  try { ventures = (await ctx.api.get('/api/ventures'))?.ventures || []; }
  catch { if (live()) section.style.display = 'none'; return; } // 401 for visitors
  const raisingName = (await fundP)?.ventureName || null;
  if (!live()) return;

  const top = ventures
    .filter((v) => v.status === 'active')
    .sort((a, b) => Number(b.apy) - Number(a.apy))
    .slice(0, 3);
  const list = ctx.list(root, 'home.ventures');
  if (!list || !top.length) { section.style.display = 'none'; return; }

  list.clear();
  for (const v of top) {
    const row = list.add();
    const sector = String(v.sector || '').toUpperCase();
    const dot = ctx.slot(row, 'dot');
    if (dot) dot.style.background = SECTOR_DOT[sector] || 'var(--dt2,#c6c6c6)';
    ctx.slot(row, 'sector').textContent = sector;
    ctx.slot(row, 'name').textContent = v.name || '';
    ctx.slot(row, 'blurb').textContent = v.blurb || '';
    ctx.slot(row, 'apy').textContent = v.apy != null ? Number(v.apy).toFixed(1) : '—';
    const raising = !!raisingName && v.name === raisingName;
    const badge = ctx.slot(row, 'raising');
    if (badge) badge.style.display = raising ? 'flex' : 'none'; // template hides it
    if (raising) row.style.borderColor = 'var(--reds,#f0b9b5)';
  }
  section.style.display = '';
}

// ---- open-fundraiser banner: /api/fundraiser (auth-gated) --------------------
async function fillFundBanner(root, ctx, live, fundP) {
  const wrap = ctx.slot(root, 'home.fundBanner');
  if (!wrap) return;
  const f = await fundP;
  if (!live()) return;
  if (!f) { wrap.style.display = 'none'; return; }
  setAll(root, 'fundBanner.title',
    `${f.title} — ${usdCompact(f.raised)} of ${usdCompact(f.target)} raised`);
  const fill = ctx.slot(root, 'fundBanner.fill');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(f.pct) || 0))}%`;
  wrap.style.display = '';
}

// ---- footer network line: real BTC tip height --------------------------------
async function fillBlockTip(root, ctx, live) {
  const n = ctx.slot(root, 'footer.chain');
  if (!n) return;
  const net = ctx.wallet?.IS_MAINNET === false ? 'TESTNET' : 'MAINNET';
  n.textContent = net; // honest even if the tip fetch fails
  try {
    const res = await fetch('https://mempool.space/api/blocks/tip/height');
    if (!res.ok) throw new Error(`tip ${res.status}`);
    const h = Number((await res.text()).trim());
    if (live() && Number.isInteger(h) && h > 0) {
      n.textContent = `${net} · BTC BLOCK ${h.toLocaleString('en-US')}`;
    }
  } catch { /* leave the bare network label */ }
}
