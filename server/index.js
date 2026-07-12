import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8471);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

app.use(express.json({ limit: '64kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; " +
    "connect-src 'self' https://mempool.space https://blockstream.info " +
    "https://ethereum-rpc.publicnode.com https://eth.llamarpc.com " +
    "https://ethereum-sepolia-rpc.publicnode.com https://rpc.sepolia.org; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

// CSRF: state-changing requests must originate from this site.
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* malformed */ }
      if (originHost !== host) return next(new ApiError(403, 'Cross-origin request rejected'));
    }
    if (req.path.startsWith('/api/') && !req.is('json') && req.headers['content-length'] > 0) {
      return next(new ApiError(415, 'JSON body required'));
    }
  }
  next();
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

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Not found')));

app.use(express.static(join(ROOT, 'public'), { index: 'index.html', extensions: false }));

// Error handler — no stack traces or SQL to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err instanceof ApiError ? err.status : (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof ApiError || status < 500 ? err.message : 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`OsmoBank listening on http://127.0.0.1:${PORT}`);
});
