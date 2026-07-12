// Bundled entry for client-side wallet cryptography.
// Everything here runs IN THE BROWSER ONLY — keys never touch the server.
// Audited primitives: @noble / @scure (paulmillr), plus ethers for EVM RPC.

export { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
export { wordlist } from '@scure/bip39/wordlists/english';
export { HDKey } from '@scure/bip32';
export * as btc from '@scure/btc-signer';
export { hex, base64 } from '@scure/base';
export { sha256 } from '@noble/hashes/sha256';
export {
  Wallet as EthWallet,
  HDNodeWallet,
  JsonRpcProvider,
  formatEther,
  parseEther,
  formatUnits,
  parseUnits,
} from 'ethers';
import qrcodegen from 'qrcode-generator';
export const qrcode = qrcodegen;
