/* Live spot prices — the single source of USD rates for every screen.
 *
 * Fetches BTC/ETH/SOL/USDC from CoinGecko (free, no key, CORS-enabled; the
 * origin is allow-listed in the server's CSP connect-src). Results are cached
 * in sessionStorage for 60s so a screen walk costs one request, not ten.
 *
 * Contract: getPrices() resolves to
 *   { BTC: {usd, chg24h}, ETH: {...}, SOL: {...}, USDC: {...}, at: <ms epoch> }
 * or null when no live quote is available (network down, rate-limited) and no
 * cached quote exists. Callers MUST render '—' on null — never a made-up rate.
 * A stale cache (up to 1h old) is returned in preference to null, with its
 * original `at` timestamp so callers can label the quote time honestly.
 */
const API = 'https://api.coingecko.com/api/v3/simple/price'
  + '?ids=bitcoin,ethereum,solana,usd-coin&vs_currencies=usd&include_24hr_change=true';
const KEY = 'ob_prices';
const FRESH_MS = 60_000;        // serve from cache without refetching
const STALE_MS = 3_600_000;     // absolute ceiling — older than this is discarded

const IDS = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', 'usd-coin': 'USDC' };

function readCache() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c?.at || Date.now() - c.at > STALE_MS) return null;
    return c;
  } catch { return null; }
}

let inflight = null;

export async function getPrices() {
  const cached = readCache();
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.data;

  if (!inflight) inflight = (async () => {
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error(`price feed ${res.status}`);
      const j = await res.json();
      const data = { at: Date.now() };
      for (const [id, sym] of Object.entries(IDS)) {
        if (j[id]?.usd == null) throw new Error('price feed incomplete');
        data[sym] = { usd: j[id].usd, chg24h: j[id].usd_24h_change ?? null };
      }
      try { sessionStorage.setItem(KEY, JSON.stringify({ at: data.at, data })); } catch { /* quota */ }
      return data;
    } catch {
      return cached ? cached.data : null; // stale beats fake; null beats invented
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Format a USD value at a live rate, or '—' when no quote exists. */
export const usdAt = (prices, sym, qty) =>
  prices?.[sym]?.usd != null && Number.isFinite(qty)
    ? '$' + (qty * prices[sym].usd).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '—';
