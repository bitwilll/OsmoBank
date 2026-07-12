import { db, tx, audit } from '../db.js';
import { ApiError, str, num, oneOf, requireAuth } from '../lib/util.js';

const CHAINS = ['btc-testnet', 'eth-sepolia', 'btc', 'eth', 'sol', 'usdc'];
const KINDS = ['hd', 'imported', 'watch'];

// Basic per-chain shape checks (registry only — the server never sees keys,
// so these guard against typos/garbage, not full checksum validation).
const ETH_RE = /^0x[0-9a-fA-F]{40}$/;                                        // 0x + 40 hex
const BTC_BECH32_RE = /^(bc1|tb1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,87}$/; // bech32 charset
const BTC_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{25,90}$/;                       // base58 charset
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;                              // base58, 32–44

function checkAddressShape(chain, address) {
  if (chain === 'eth' || chain === 'eth-sepolia' || chain === 'usdc') {
    // USDC is an ERC-20, so usdc addresses take the EVM shape.
    if (!ETH_RE.test(address)) {
      throw new ApiError(400, `address is not a valid ${chain} address (expected 0x + 40 hex characters)`);
    }
  } else if (chain === 'btc' || chain === 'btc-testnet') {
    if (!BTC_BECH32_RE.test(address) && !BTC_BASE58_RE.test(address)) {
      throw new ApiError(400, `address is not a valid ${chain} address (expected bech32 or base58)`);
    }
  } else if (chain === 'sol') {
    if (!SOL_RE.test(address)) {
      throw new ApiError(400, 'address is not a valid sol address (expected base58, 32–44 characters)');
    }
  }
}

const walletJson = (w) => ({
  id: w.id, chain: w.chain, address: w.address, label: w.label, kind: w.kind, createdAt: w.created_at,
});

/** Load a wallet by :id and enforce ownership. 404 unknown, 403 not owned. */
function ownWallet(req) {
  const id = num(req.params.id, { min: 1, int: true, name: 'id' });
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
  if (!wallet) throw new ApiError(404, 'Wallet not found');
  if (wallet.user_id !== req.user.id) throw new ApiError(403, 'Not your wallet');
  return wallet;
}

export default function mount(app) {
  app.get('/api/wallets', requireAuth, (req, res, next) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at DESC, id DESC')
        .all(req.user.id);
      res.json({ wallets: rows.map(walletJson) });
    } catch (e) { next(e); }
  });

  app.post('/api/wallets', requireAuth, (req, res, next) => {
    try {
      const chain = oneOf(str(req.body?.chain, { min: 3, max: 20, name: 'chain' }).toLowerCase(), CHAINS, 'chain');
      const address = str(req.body?.address, { min: 4, max: 128, name: 'address' });
      checkAddressShape(chain, address);
      const label = req.body?.label !== undefined && req.body?.label !== null
        ? str(req.body.label, { min: 1, max: 60, name: 'label' })
        : null;
      const kind = req.body?.kind !== undefined
        ? oneOf(str(req.body.kind, { min: 2, max: 10, name: 'kind' }).toLowerCase(), KINDS, 'kind')
        : 'hd';

      const wallet = tx(() => {
        const clash = db.prepare(
          'SELECT id FROM wallets WHERE user_id = ? AND chain = ? AND address = ?')
          .get(req.user.id, chain, address);
        if (clash) throw new ApiError(409, 'That address is already registered on this chain');
        const id = Number(db.prepare(
          'INSERT INTO wallets (user_id, chain, address, label, kind) VALUES (?,?,?,?,?)')
          .run(req.user.id, chain, address, label, kind).lastInsertRowid);
        audit(req.user.id, 'wallet.add', `wallet:${id}`, `${chain}:${address}`);
        return db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
      });

      res.status(201).json({ wallet: walletJson(wallet) });
    } catch (e) { next(e); }
  });

  app.patch('/api/wallets/:id', requireAuth, (req, res, next) => {
    try {
      const existing = ownWallet(req);
      const label = str(req.body?.label, { min: 1, max: 60, name: 'label' });

      const wallet = tx(() => {
        db.prepare('UPDATE wallets SET label = ? WHERE id = ?').run(label, existing.id);
        audit(req.user.id, 'wallet.relabel', `wallet:${existing.id}`, label);
        return db.prepare('SELECT * FROM wallets WHERE id = ?').get(existing.id);
      });

      res.json({ wallet: walletJson(wallet) });
    } catch (e) { next(e); }
  });

  app.delete('/api/wallets/:id', requireAuth, (req, res, next) => {
    try {
      const existing = ownWallet(req);

      tx(() => {
        db.prepare('DELETE FROM wallets WHERE id = ?').run(existing.id);
        audit(req.user.id, 'wallet.remove', `wallet:${existing.id}`, `${existing.chain}:${existing.address}`);
      });

      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
