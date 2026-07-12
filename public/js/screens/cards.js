/* Cards screen (light touch): real card holder name + real month spend from
 * outgoing transfers; gift store and card buttons stay global demo toasts. */

// Ticker prices for converting on-chain amounts to USD display.
const USD_PRICE = { USDC: 1, USD: 1, OSM: 0.4182, BTC: 60684, ETH: 3530, SOL: 37.84 };

export async function hydrate(root, ctx) {
  const me = ctx.me();
  if (!me) return;

  // OSMOCARD holder: "A. OKAFOR" (first initial + last name), uppercased.
  const holder = ctx.slot(root, 'cards.holder');
  if (holder) {
    const parts = (me.user.name || '').trim().split(/\s+/).filter(Boolean);
    const label = parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : (parts[0] || '');
    if (label) holder.textContent = label.toUpperCase();
  }

  // Month spend: sum of caller's outgoing transfers this month (ledger-ish
  // approximation), converted to USD by ticker price.
  try {
    const { transfers } = await ctx.api.get('/api/transfers');
    const now = new Date();
    const ym = now.toISOString().slice(0, 7); // 'YYYY-MM' (UTC, matches createdAt)
    let spend = 0;
    for (const t of transfers || []) {
      if (t.fromUser !== me.user.id) continue;              // outgoing only
      if (t.status === 'failed') continue;
      if (String(t.createdAt || '').slice(0, 7) !== ym) continue;
      spend += Number(t.amount || 0) * (USD_PRICE[t.currency] ?? 1);
    }

    const month = now.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toUpperCase();
    const title = ctx.slot(root, 'cards.spendTitle');
    if (title) title.textContent = `${month} SPEND · ${ctx.fmt.usd2(spend)}`;

    // Category rows stay decor; values re-titled proportionally (2dp).
    const shares = [
      ['cards.catGroceries', 0.40],
      ['cards.catTransit', 0.25],
      ['cards.catDining', 0.35],
    ];
    for (const [name, share] of shares) {
      const cell = ctx.slot(root, name);
      if (cell) cell.textContent = ctx.fmt.usd2(spend * share);
    }
  } catch (e) {
    ctx.errToast(e);
  }
}
