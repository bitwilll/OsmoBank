/* Dashboard hydrator — total assets, next dividend, live vote, asset table,
 * your ventures, recent activity, goals, card, referral. Everything below is
 * the member's real data (or an honest empty state); no demo figures. */

// Reference spot prices used only to value on-chain holdings a member actually
// holds (a brand-new account holds nothing, so these never fabricate a balance).
const RATES = { BTC: 60684, ETH: 3530, SOL: 37.84, OSM: 0.4182 };

const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-3)}` : '');

const parseIso = (iso) => new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');

function endsLabel(iso) {
  if (!iso) return 'ENDS SOON';
  const t = parseIso(iso).getTime() - Date.now();
  if (Number.isNaN(t)) return 'ENDS SOON';
  if (t <= 0) return 'ENDED';
  const d = Math.floor(t / 86400000);
  const h = Math.floor((t % 86400000) / 3600000);
  return d > 0 ? `ENDS ${d}D ${h}H` : `ENDS ${Math.max(1, h)}H`;
}

function quarterOf(iso) {
  if (!iso) return '';
  const d = parseIso(iso);
  return Number.isNaN(d.getTime()) ? '' : `Q${Math.floor(d.getMonth() / 3) + 1}`;
}

// Ledger-kind → activity row presentation.
const ACT = {
  deposit: { icon: 'account_balance', color: 'var(--grn,#17a562)', title: 'Deposit' },
  transfer_in: { icon: 'call_received', color: 'var(--grn,#17a562)', title: 'Received' },
  transfer_out: { icon: 'north_east', color: 'var(--ink,#0a0a0a)', title: 'Sent' },
  invest: { icon: 'diamond', color: 'var(--ink,#0a0a0a)', title: 'Invested' },
  exit: { icon: 'logout', color: 'var(--grn,#17a562)', title: 'Exited venture' },
  dividend: { icon: 'payments', color: 'var(--grn,#17a562)', title: 'Dividend' },
  reimbursement: { icon: 'receipt_long', color: 'var(--grn,#17a562)', title: 'Reimbursement' },
  giftcard: { icon: 'card_giftcard', color: 'var(--ink,#0a0a0a)', title: 'Gift card' },
  adjust: { icon: 'flag', color: 'var(--ink,#0a0a0a)', title: 'Goal' },
  fee: { icon: 'receipt_long', color: 'var(--red,#c47b10)', title: 'Fee' },
};

export async function hydrate(root, ctx) {
  const { api, fmt, wallet, slot, nav } = ctx;

  // Guard against overlapping hydrations (screen left + re-entered mid-fetch).
  const seq = (root.__dashSeq = (root.__dashSeq || 0) + 1);

  let meData, portfolio, proposals, walletsRes, reports, activityRes, goalsRes, cardsRes;
  try {
    [meData, portfolio, proposals, walletsRes, reports, activityRes, goalsRes, cardsRes] = await Promise.all([
      ctx.refreshMe().then((m) => m || ctx.me()),
      api.get('/api/portfolio'),
      api.get('/api/proposals'),
      api.get('/api/wallets'),
      api.get('/api/reports').catch(() => null), // dividendsYtd; optional
      api.get('/api/activity').catch(() => null),
      api.get('/api/goals').catch(() => null),
      api.get('/api/cards').catch(() => null),
    ]);
  } catch (e) {
    ctx.errToast(e);
    return;
  }
  if (root.__dashSeq !== seq) return;

  const usdc = Number(meData?.balances?.USDC || 0);
  const osm = Number(meData?.balances?.OSM || 0);
  const positions = portfolio?.positions || [];
  const total = usdc + osm * RATES.OSM + Number(portfolio?.deployed || 0);

  // ---- total assets ---------------------------------------------------------
  const [ints, cents] = fmt.usd2(total).split('.');
  slot(root, 'dash.totalAssets').textContent = ints;
  slot(root, 'dash.totalAssetsCents').textContent = `.${cents}`;

  const divYtd = reports?.dividendsYtd ?? positions.reduce((s, p) => s + Number(p.dividendsPaid || 0), 0);
  const walletCount = (walletsRes?.wallets?.length || 0) + 2; // on-chain wallets + USDC & OSM ledgers
  slot(root, 'dash.ytd').textContent = `${fmt.signedUsd(divYtd)} YTD`;
  slot(root, 'dash.walletVenture').textContent =
    `${fmt.num(walletCount)} WALLETS · ${fmt.num(positions.length)} VENTURES`;
  slot(root, 'dash.walletsHead').textContent = `WALLETS / ${fmt.num(walletCount)} ACTIVE`;
  const vpl = slot(root, 'dash.venturesPl');
  if (vpl) {
    const netPl = Number(portfolio?.netPl || 0);
    vpl.textContent = `${fmt.signedUsd(netPl)} ALL-TIME`;
    vpl.style.color = netPl >= 0 ? 'var(--grn,#17a562)' : 'var(--red,#c47b10)';
  }

  // ---- next dividend card ---------------------------------------------------
  const nd = portfolio?.nextDividend;
  if (nd) {
    slot(root, 'dash.nextDivAmount').textContent = fmt.usd(nd.amount);
    slot(root, 'dash.nextDivLabel').textContent = `NEXT DIVIDEND · ${fmt.date(nd.date)}`;
    const q = quarterOf(nd.date);
    slot(root, 'dash.nextDivVenture').textContent = `${nd.venture} · ${q ? q + ' ' : ''}payout`;
  } else {
    slot(root, 'dash.nextDivAmount').textContent = fmt.usd(0);
    slot(root, 'dash.nextDivLabel').textContent = 'NEXT DIVIDEND · —';
    slot(root, 'dash.nextDivVenture').textContent = 'No dividend scheduled yet';
  }

  // ---- live vote card -------------------------------------------------------
  const live = (proposals?.proposals || []).find((p) => p.status === 'live');
  if (live) {
    slot(root, 'dash.voteCode').textContent = `LIVE VOTE · ${live.code}`;
    slot(root, 'dash.voteEnds').textContent = endsLabel(live.endsAt);
    slot(root, 'dash.voteTitle').textContent = live.title;
    slot(root, 'dash.votePct').textContent = `${fmt.pct(live.forPct || 0, 0)} FOR`;
    slot(root, 'dash.voteMeter').style.width = `${Math.max(0, Math.min(100, live.forPct || 0))}%`;
  } else {
    slot(root, 'dash.voteCode').textContent = 'NO LIVE VOTE';
    slot(root, 'dash.voteEnds').textContent = '—';
    slot(root, 'dash.voteTitle').textContent = 'No proposals are live right now — check back soon.';
    slot(root, 'dash.votePct').textContent = `${fmt.pct(0, 0)} FOR`;
    slot(root, 'dash.voteMeter').style.width = '0%';
  }

  // ---- asset table ----------------------------------------------------------
  const L = ctx.list(root, 'dash.assets');
  L.clear();

  const addRow = (a) => {
    const row = L.add();
    slot(row, 'dash.asset.dot').style.background = a.color;
    slot(row, 'dash.asset.name').textContent = a.name;
    const sub = slot(row, 'dash.asset.sub');
    const badge = slot(row, 'dash.asset.badge');
    if (a.badge) {
      sub.style.display = 'none';
      badge.style.display = '';
      badge.textContent = a.badge;
    } else {
      sub.textContent = a.sub;
    }
    slot(row, 'dash.asset.bal').textContent = a.bal;
    slot(row, 'dash.asset.value').textContent = fmt.usd(a.value);
    // We do not track a 24h price series, so we show "—" rather than a fabricated change.
    const chg = slot(row, 'dash.asset.chg');
    chg.textContent = '—';
    chg.style.color = 'var(--fnt,#a3a3a3)';
    const share = total > 0 ? (a.value / total) * 100 : 0;
    const fill = slot(row, 'dash.asset.meterFill');
    fill.style.width = `${Math.max(0, Math.min(100, share))}%`;
    fill.style.backgroundImage = `radial-gradient(circle,${a.color} 1.6px,transparent 2.1px)`;
    slot(row, 'dash.asset.share').textContent = fmt.pct(share, 1).replace('%', '');
  };

  addRow({
    color: '#2775ca', name: 'USD Coin', sub: 'SPENDING',
    bal: fmt.usd2(usdc).slice(1), value: usdc,
  });
  addRow({
    color: '#c47b10', name: 'OSM', badge: 'GOVERNANCE',
    bal: fmt.num(osm), value: osm * RATES.OSM,
  });

  if (wallet.isUnlocked()) {
    const addrs = wallet.addresses() || {};
    let chains = null;
    try { chains = await wallet.chainBalances(); } catch { chains = null; }
    if (root.__dashSeq !== seq) return; // superseded while awaiting on-chain APIs
    const btcKey = wallet.BTC_CHAIN;
    const ethKey = wallet.ETH_CHAIN;
    const btc = Number(chains?.[btcKey] ?? 0);
    const eth = Number(chains?.[ethKey] ?? 0);
    addRow({
      color: '#f7931a', name: 'Bitcoin', sub: shortAddr(addrs[btcKey]) || wallet.CHAINS[btcKey].symbol,
      bal: btc.toFixed(5), value: btc * RATES.BTC,
    });
    addRow({
      color: '#627eea', name: 'Ethereum', sub: shortAddr(addrs[ethKey]) || wallet.CHAINS[ethKey].symbol,
      bal: eth.toFixed(4), value: eth * RATES.ETH,
    });
  }

  // ---- your ventures --------------------------------------------------------
  fillList(ctx, root, 'dash.ventures', 'dash.venturesEmpty', positions.slice(0, 6), (row, p) => {
    slot(row, 'dash.venture.sector').textContent = String(p.sector || 'VENTURE').toUpperCase();
    slot(row, 'dash.venture.name').textContent = p.name;
    slot(row, 'dash.venture.apy').textContent = Number(p.apy || 0).toFixed(1);
    slot(row, 'dash.venture.stake').textContent = `STAKE ${fmt.usd(p.stake)}`;
    const pl = slot(row, 'dash.venture.pl');
    pl.textContent = fmt.signedUsd(p.pl || 0);
    pl.style.color = (p.pl || 0) >= 0 ? 'var(--grn,#17a562)' : 'var(--red,#c47b10)';
    row.addEventListener('click', () => nav('ventures'));
  });

  // ---- recent activity ------------------------------------------------------
  fillList(ctx, root, 'dash.activity', 'dash.activityEmpty', activityRes?.activity || [], (row, a) => {
    const meta = ACT[a.kind] || { icon: 'swap_horiz', color: 'var(--mut,#757575)', title: a.kind };
    const ic = slot(row, 'dash.act.icon');
    ic.textContent = meta.icon;
    ic.style.color = meta.color;
    slot(row, 'dash.act.title').textContent = meta.title;
    slot(row, 'dash.act.sub').textContent =
      `${fmt.date(a.createdAt)}${a.memo ? ' · ' + String(a.memo).toUpperCase() : ''}`;
    const amt = slot(row, 'dash.act.amount');
    const pos = a.delta >= 0;
    const abs = Math.abs(a.delta);
    amt.textContent = a.currency === 'USDC'
      ? `${pos ? '+' : '−'}${fmt.usd2(abs)}`
      : `${pos ? '+' : '−'}${fmt.num(abs)} ${a.currency}`;
    amt.style.color = pos ? 'var(--grn,#17a562)' : 'var(--ink,#0a0a0a)';
  });

  // ---- goals ----------------------------------------------------------------
  fillList(ctx, root, 'dash.goals', 'dash.goalsEmpty', (goalsRes?.goals || []).slice(0, 3), (row, g) => {
    slot(row, 'dash.goal.name').textContent = g.name;
    const pct = Math.max(0, Math.min(100, Number(g.pct || 0)));
    slot(row, 'dash.goal.pct').textContent = `${Math.round(pct)}%`;
    slot(row, 'dash.goal.bar').style.width = `${pct}%`;
    slot(row, 'dash.goal.amt').textContent = `${fmt.usd(g.saved)} / ${fmt.usd(g.target)}`;
  });

  // ---- card preview ---------------------------------------------------------
  const primary = (cardsRes?.cards || [])[0];
  if (primary) {
    slot(root, 'dash.card.last4').textContent = primary.last4;
    slot(root, 'dash.card.holder').textContent =
      `${String(meData?.user?.name || '—').toUpperCase()} · ${String(primary.kind || 'virtual').toUpperCase()}`;
  }
  const spend = Number(cardsRes?.spend || 0);
  slot(root, 'dash.card.spend').textContent = `${spend > 0 ? '−' : ''}${fmt.usd2(spend)} · THIS MONTH`;

  // ---- referral (real link; stats are genuinely zero until a program exists) --
  const handle = meData?.user?.handle || 'you';
  slot(root, 'dash.ref.link').textContent = `osmo.money/r/${handle}`;
}

/** Populate a data-list, or reveal its empty-state sibling when there are no rows. */
function fillList(ctx, root, listName, emptyName, items, fill) {
  const box = ctx.list(root, listName);
  const empty = ctx.slot(root, emptyName);
  if (!box) return;
  box.clear();
  if (!items.length) {
    box.el.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }
  box.el.style.display = '';
  if (empty) empty.style.display = 'none';
  items.forEach((item) => fill(box.add(), item));
}
