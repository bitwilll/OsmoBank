import { db, tx, audit } from '../db.js';
import { ApiError, str, num, oneOf, requireAuth } from '../lib/util.js';

const CHAINS = ['btc-testnet', 'eth-sepolia', 'btc', 'eth', 'sol', 'usdc'];
const EVM_CHAINS = ['eth', 'eth-sepolia', 'usdc']; // USDC is an ERC-20 → EVM address shape
const KINDS = ['hd', 'imported', 'watch'];

// Basic per-chain shape checks (registry only — the server never sees keys,
// so these guard against typos/garbage, not full checksum validation).
// btc vs btc-testnet are distinct networks: a mainnet address (bc1…/1…/3…)
// can never resolve on testnet (tb1…/m…/n…/2…) and vice versa.
const ETH_RE = /^0x[0-9a-fA-F]{40}$/;                                            // 0x + 40 hex
const BTC_MAIN_BECH32_RE = /^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,87}$/;      // mainnet bech32
const BTC_TEST_BECH32_RE = /^tb1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,87}$/;      // testnet bech32
const BTC_MAIN_BASE58_RE = /^[13][1-9A-HJ-NP-Za-km-z]{24,89}$/;                  // mainnet legacy 1…/3…
const BTC_TEST_BASE58_RE = /^[mn2][1-9A-HJ-NP-Za-km-z]{24,89}$/;                 // testnet legacy m…/n…/2…
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;                                  // base58, 32–44
const CTRL_RE = /[\u0000-\u001f\u007f]/;                                          // C0 controls + DEL

function checkAddressShape(chain, address) {
  if (EVM_CHAINS.includes(chain)) {
    if (!ETH_RE.test(address)) {
      throw new ApiError(400, `address is not a valid ${chain} address (expected 0x + 40 hex characters)`);
    }
  } else if (chain === 'btc') {
    if (!BTC_MAIN_BECH32_RE.test(address) && !BTC_MAIN_BASE58_RE.test(address)) {
      throw new ApiError(400, 'address is not a valid btc address (expected bech32 bc1… or base58 1…/3…)');
    }
  } else if (chain === 'btc-testnet') {
    if (!BTC_TEST_BECH32_RE.test(address) && !BTC_TEST_BASE58_RE.test(address)) {
      throw new ApiError(400, 'address is not a valid btc-testnet address (expected bech32 tb1… or base58 m…/n…/2…)');
    }
  } else if (chain === 'sol') {
    if (!SOL_RE.test(address)) {
      throw new ApiError(400, 'address is not a valid sol address (expected base58, 32–44 characters)');
    }
  }
}

/** Validate a wallet label. Control characters are rejected because node:sqlite
 *  silently truncates TEXT bindings at an embedded NUL. */
function cleanLabel(v) {
  const label = str(v, { min: 1, max: 60, name: 'label' });
  if (CTRL_RE.test(label)) throw new ApiError(400, 'label must not contain control characters');
  return label;
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
      let address = str(req.body?.address, { min: 4, max: 128, name: 'address' });
      checkAddressShape(chain, address);
      // EVM addresses are case-insensitive (EIP-55 casing is only a checksum) —
      // normalize so the same account cannot be registered twice under two casings.
      // btc/sol base58 IS case-sensitive, so those are stored as submitted.
      if (EVM_CHAINS.includes(chain)) address = address.toLowerCase();
      const label = req.body?.label !== undefined && req.body?.label !== null
        ? cleanLabel(req.body.label)
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
      const label = cleanLabel(req.body?.label);

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
