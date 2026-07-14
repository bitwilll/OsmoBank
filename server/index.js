import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initDb } from './db.js';
import { ApiError, loadSession } from './lib/util.js';
import mountAuth from './routes/auth.js';
import mountWallets from './routes/wallets.js';
import mountVentures from './routes/ventures.js';
import mountPortfolio from './routes/portfolio.js';
import mountMoney from './routes/money.js';
import mountDao from './routes/dao.js';
import mountAdmin from './routes/admin.js';
import mountSecurity from './routes/security.js';
import mountCards from './routes/cards.js';
import mountSupport from './routes/support.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8471);

const app = express();
app.disable('x-powered-by');
// Behind Vercel's proxy, trust one hop so req.ip / req.secure reflect the real
// client (via X-Forwarded-*). Locally we take the socket address directly.
app.set('trust proxy', process.env.VERCEL ? 1 : false);

app.use(express.json({ limit: '64kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // MITM defense: force HTTPS for 2 years (browsers ignore this over plain HTTP,
  // so it is only enforced once served over TLS). upgrade-insecure-requests in the
  // CSP additionally rewrites any http:// subresource to https:// before it leaves.
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  // Lock down powerful features; WebAuthn (passkeys) is allowed only for same-origin.
  res.setHeader('Permissions-Policy',
    'publickey-credentials-get=(self), publickey-credentials-create=(self), ' +
    'geolocation=(), camera=(), microphone=(), usb=(), payment=(self), interest-cohort=()');
  // Isolate the browsing context so a malicious opener/embedder cannot reach it.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; " +
    "connect-src 'self' https://mempool.space https://blockstream.info " +
    "https://ethereum-rpc.publicnode.com https://eth.llamarpc.com " +
    "https://ethereum-sepolia-rpc.publicnode.com https://rpc.sepolia.org; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests");
  next();
});

// CSRF: state-changing requests must be same-origin. Primary defense is the
// SameSite=Strict session cookie (never sent cross-site); these checks are
// belt-and-suspenders using Origin and the Fetch metadata header.
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* malformed */ }
      if (originHost !== host) return next(new ApiError(403, 'Cross-origin request rejected'));
    }
    // Fetch metadata: modern browsers stamp where the request came from. Reject
    // anything a browser marks as cross-site/same-site (only same-origin, or a
    // non-browser 'none', is allowed) — this also covers requests with no Origin.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      return next(new ApiError(403, 'Cross-site request rejected'));
    }
    if (req.path.startsWith('/api/') && !req.is('json') && req.headers['content-length'] > 0) {
      return next(new ApiError(415, 'JSON body required'));
    }
  }
  next();
});

// Ensure schema (+ seed) is applied before any request touches the DB. initDb()
// is memoised, so this awaits once per instance and is a no-op afterward — which
// is exactly what a serverless cold start needs.
let dbReady = false;
app.use((req, res, next) => {
  if (dbReady) return next();
  initDb().then(() => { dbReady = true; next(); }).catch((err) => {
    // The database is unreachable or not yet configured (e.g. TURSO_* env not
    // set on the deployment). Surface an honest 503 instead of a bare 500 so
    // clients can retry; the real cause is logged, never sent to the client.
    console.error('DB init failed:', err);
    res.setHeader('Retry-After', '30');
    res.status(503).json({ error: 'Service temporarily unavailable — please try again in a moment.' });
  });
});

app.use(loadSession);

mountAuth(app);
mountWallets(app);
mountVentures(app);
mountPortfolio(app);
mountMoney(app);
mountDao(app);
mountAdmin(app);
mountSecurity(app);
mountCards(app);
mountSupport(app);

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Not found')));

app.use(express.static(join(ROOT, 'public'), { index: 'index.html', extensions: false }));

// Error handler — no stack traces or SQL to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Honour client-error statuses carried by our ApiError and by http-errors from
  // body-parser (entity.parse.failed → 400, entity.too.large → 413, unsupported
  // charset → 415, …). Anything without a 4xx status is a real server fault → 500.
  const carried = Number(err?.status ?? err?.statusCode);
  const status = err instanceof ApiError ? err.status
    : (Number.isInteger(carried) && carried >= 400 && carried < 500 ? carried : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status < 500 ? err.message : 'Internal error' });
});

// On Vercel the app is imported by api/index.js and served as a function — no
// listen there. Only bind a port when this file is run directly (local / tests).
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) {
  initDb()
    .then(() => app.listen(PORT, '127.0.0.1', () => console.log(`OsmoBank listening on http://127.0.0.1:${PORT}`)))
    .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
}

export default app;
