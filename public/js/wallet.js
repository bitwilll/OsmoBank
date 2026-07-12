/* OsmoBank client-side wallet.
 *
 * ALL key material lives in the browser. The server only ever receives derived
 * PUBLIC addresses (watch-only registry) — the mnemonic and private keys never
 * leave this device.
 *
 * ⚠️  NETWORK = 'mainnet' — this wallet derives and spends REAL Bitcoin and
 *     Ethereum. Addresses are standard BIP84 (bc1…) and BIP44 (0x…) mainnet
 *     addresses; sends broadcast real, irreversible transactions. Set NETWORK
 *     to 'testnet' below to exercise send/receive with no financial risk.
 */
import { api } from './api.js';

// ── network selection ───────────────────────────────────────────────────────
export const NETWORK = 'mainnet'; // 'mainnet' | 'testnet'

const NET_CONFIG = {
  mainnet: {
    btc: {
      key: 'btc', path: "m/84'/0'/0'/0/0", // BIP84, coin type 0' (mainnet)
      api: 'https://mempool.space/api',
      explorer: (tx) => `https://mempool.space/tx/${tx}`,
      symbol: 'BTC', label: 'MAINNET · NATIVE SEGWIT', faucet: null,
    },
    eth: {
      key: 'eth', rpc: 'https://ethereum-rpc.publicnode.com',
      explorer: (tx) => `https://etherscan.io/tx/${tx}`,
      symbol: 'ETH', label: 'MAINNET', faucet: null,
    },
  },
  testnet: {
    btc: {
      key: 'btc-testnet', path: "m/84'/1'/0'/0/0", // coin type 1' (testnet)
      api: 'https://mempool.space/testnet/api',
      explorer: (tx) => `https://mempool.space/testnet/tx/${tx}`,
      symbol: 'tBTC', label: 'TESTNET', faucet: 'https://coinfaucet.eu/en/btc-testnet/',
    },
    eth: {
      key: 'eth-sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
      explorer: (tx) => `https://sepolia.etherscan.io/tx/${tx}`,
      symbol: 'sETH', label: 'SEPOLIA', faucet: 'https://sepoliafaucet.com/',
    },
  },
};

const NET = NET_CONFIG[NETWORK];
export const BTC_CHAIN = NET.btc.key; // 'btc' on mainnet
export const ETH_CHAIN = NET.eth.key; // 'eth' on mainnet
export const IS_MAINNET = NETWORK === 'mainnet';

const BTC_API = NET.btc.api;
const ETH_RPC = NET.eth.rpc;
const BTC_PATH = NET.btc.path;

export const CHAINS = {
  [NET.btc.key]: {
    name: 'Bitcoin', net: NET.btc.label, symbol: NET.btc.symbol, color: '#f7931a',
    explorer: NET.btc.explorer, faucet: NET.btc.faucet,
  },
  [NET.eth.key]: {
    name: 'Ethereum', net: NET.eth.label, symbol: NET.eth.symbol, color: '#627eea',
    explorer: NET.eth.explorer, faucet: NET.eth.faucet,
  },
};

let libs = null;
async function lib() {
  if (!libs) libs = await import('../vendor/wallet-libs.js');
  return libs;
}
const btcNetwork = (L) => (IS_MAINNET ? L.btc.NETWORK : L.btc.TEST_NETWORK);

// ---- in-memory vault ------------------------------------------------------
let vault = null; // { mnemonic, btcAddress, ethAddress }

export const isUnlocked = () => !!vault;
export const addresses = () => vault
  ? { [NET.btc.key]: vault.btcAddress, [NET.eth.key]: vault.ethAddress }
  : null;

async function derive(mnemonic) {
  const L = await lib();
  if (!L.validateMnemonic(mnemonic, L.wordlist)) throw new Error('That recovery phrase is not valid (BIP39).');
  const seed = L.mnemonicToSeedSync(mnemonic);
  const node = L.HDKey.fromMasterSeed(seed).derive(BTC_PATH);
  const btcAddress = L.btc.p2wpkh(node.publicKey, btcNetwork(L)).address;
  const ethWallet = L.HDNodeWallet.fromPhrase(mnemonic); // m/44'/60'/0'/0/0 — network-agnostic
  return { mnemonic, btcAddress, ethAddress: ethWallet.address };
}

/** Create a brand-new wallet. Returns the mnemonic — show it ONCE for backup. */
export async function createVault() {
  const L = await lib();
  const mnemonic = L.generateMnemonic(L.wordlist, 128); // 12 words
  vault = await derive(mnemonic);
  await registerAddresses();
  return { ...vault };
}

/** Import/restore from a recovery phrase. */
export async function importVault(mnemonic) {
  vault = await derive(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '));
  await registerAddresses();
  return { ...vault };
}

export function lockVault() { vault = null; }

async function registerAddresses() {
  for (const [chain, address] of Object.entries(addresses())) {
    try {
      await api.post('/api/wallets', { chain, address, label: 'Primary', kind: 'hd' });
    } catch (e) {
      if (e.status !== 409) throw e; // already registered is fine
    }
  }
}

// ---- encrypted device backup ----------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function kdf(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptVault(passphrase) {
  if (!vault) throw new Error('No wallet is unlocked.');
  if (passphrase.length < 8) throw new Error('Backup passphrase must be at least 8 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 310000;
  const key = await kdf(passphrase, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(vault.mnemonic));
  return {
    version: 1, app: 'osmobank', network: NETWORK, kdf: 'PBKDF2-SHA256', iterations,
    salt: b64(salt), iv: b64(iv), ciphertext: b64(ct),
    addresses: addresses(), createdAt: new Date().toISOString(),
  };
}

export async function decryptBackup(backup, passphrase) {
  if (!backup || backup.app !== 'osmobank' || !backup.ciphertext) throw new Error('Not an OsmoBank backup file.');
  const key = await kdf(passphrase, unb64(backup.salt), backup.iterations || 310000);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv) }, key, unb64(backup.ciphertext));
  } catch {
    throw new Error('Wrong passphrase (or corrupted backup).');
  }
  return dec.decode(pt);
}

/** Persist the encrypted vault on this device (per-handle key). */
export async function saveOnDevice(handle, passphrase) {
  const backup = await encryptVault(passphrase);
  localStorage.setItem(`ob_vault:${handle}`, JSON.stringify(backup));
}
export function deviceBackup(handle) {
  const raw = localStorage.getItem(`ob_vault:${handle}`);
  return raw ? JSON.parse(raw) : null;
}
export async function unlockFromDevice(handle, passphrase) {
  const backup = deviceBackup(handle);
  if (!backup) throw new Error('No wallet backup on this device.');
  const mnemonic = await decryptBackup(backup, passphrase);
  vault = await derive(mnemonic);
  return { ...vault };
}
export function forgetDevice(handle) { localStorage.removeItem(`ob_vault:${handle}`); }

export async function downloadBackup(passphrase) {
  const backup = await encryptVault(passphrase);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `osmobank-vault-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- balances ---------------------------------------------------------------
export async function chainBalances() {
  if (!vault) return null;
  const L = await lib();
  const out = {};
  const [btcRes, ethRes] = await Promise.allSettled([
    fetch(`${BTC_API}/address/${vault.btcAddress}`).then((r) => r.json()),
    new L.JsonRpcProvider(ETH_RPC).getBalance(vault.ethAddress),
  ]);
  out[NET.btc.key] = btcRes.status === 'fulfilled'
    ? (btcRes.value.chain_stats.funded_txo_sum - btcRes.value.chain_stats.spent_txo_sum) / 1e8
    : null;
  out[NET.eth.key] = ethRes.status === 'fulfilled' ? Number(L.formatEther(ethRes.value)) : null;
  return out;
}

// ---- receive ----------------------------------------------------------------
export async function receiveInfo(chain) {
  if (!vault) throw new Error('Unlock your wallet first.');
  const L = await lib();
  const address = addresses()[chain];
  const qr = L.qrcode(0, 'M');
  qr.addData(chain === NET.btc.key ? `bitcoin:${address}` : `ethereum:${address}`);
  qr.make();
  return { address, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
}

// ---- send ---------------------------------------------------------------------
export async function send(chain, to, amount) {
  if (!vault) throw new Error('Unlock your wallet first.');
  if (!(amount > 0)) throw new Error('Amount must be positive.');
  const txid = chain === NET.btc.key
    ? await sendBtc(to, amount)
    : await sendEth(to, amount);
  await api.post('/api/transfers/record', {
    chain, txid, toAddress: to, amount, currency: CHAINS[chain].symbol,
  }).catch(() => { /* history record is best-effort; the send already broadcast */ });
  return { txid, explorer: CHAINS[chain].explorer(txid) };
}

async function sendEth(to, amountEth) {
  const L = await lib();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('That is not a valid Ethereum address.');
  const provider = new L.JsonRpcProvider(ETH_RPC);
  const signer = L.HDNodeWallet.fromPhrase(vault.mnemonic).connect(provider);
  // ethers fills nonce/gas/chainId from the connected network and signs locally.
  const tx = await signer.sendTransaction({ to, value: L.parseEther(String(amountEth)) });
  return tx.hash;
}

async function sendBtc(to, amountBtc) {
  const L = await lib();
  const net = btcNetwork(L);
  const sats = BigInt(Math.round(amountBtc * 1e8));
  if (sats < 546n) throw new Error('Amount is below the dust limit.');

  // Reject a recipient address from the wrong network before we build anything —
  // btc.Transaction would throw, but a clear message avoids surprise.
  let outScript;
  try { outScript = L.btc.Address(net).decode(to); }
  catch { throw new Error(`That is not a valid ${IS_MAINNET ? 'Bitcoin' : 'Bitcoin testnet'} address.`); }
  void outScript;

  const seed = L.mnemonicToSeedSync(vault.mnemonic);
  const node = L.HDKey.fromMasterSeed(seed).derive(BTC_PATH);
  const spend = L.btc.p2wpkh(node.publicKey, net);

  const utxos = await fetch(`${BTC_API}/address/${vault.btcAddress}/utxo`).then((r) => r.json());
  const confirmed = utxos.filter((u) => u.status && u.status.confirmed);
  if (!confirmed.length) {
    throw new Error(utxos.length
      ? 'Your incoming funds are still confirming — try again in a few minutes.'
      : 'No confirmed funds on this address yet.');
  }
  const fees = await fetch(`${BTC_API}/v1/fees/recommended`).then((r) => r.json())
    .catch(() => ({ halfHourFee: IS_MAINNET ? 10 : 2 }));
  const feeRate = BigInt(Math.max(1, Math.ceil(fees.halfHourFee || (IS_MAINNET ? 10 : 2))));

  // Greedy coin selection with iterative fee estimate (P2WPKH: ~68 vB/input, 31 vB/output, 11 overhead).
  confirmed.sort((a, b) => b.value - a.value);
  const picked = [];
  let inTotal = 0n;
  let fee = 0n;
  for (const u of confirmed) {
    picked.push(u);
    inTotal += BigInt(u.value);
    fee = feeRate * BigInt(11 + picked.length * 68 + 2 * 31);
    if (inTotal >= sats + fee) break;
  }
  if (inTotal < sats + fee) throw new Error('Not enough confirmed balance to cover amount + network fee.');

  const tx = new L.btc.Transaction();
  for (const u of picked) {
    tx.addInput({
      txid: u.txid, index: u.vout,
      witnessUtxo: { script: spend.script, amount: BigInt(u.value) },
    });
  }
  tx.addOutputAddress(to, sats, net);
  const change = inTotal - sats - fee;
  if (change >= 546n) tx.addOutputAddress(vault.btcAddress, change, net);

  tx.sign(node.privateKey);
  tx.finalize();

  const res = await fetch(`${BTC_API}/tx`, { method: 'POST', body: L.hex.encode(tx.extract()) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast rejected: ${text.slice(0, 120)}`);
  return text.trim();
}
