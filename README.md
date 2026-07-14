# OsmoBank — member-owned DAO bank

Full-stack implementation of the **OsmoBank App** Claude Design project: a
decentralized bank where members hold multichain crypto wallets, invest in
DAO-vetted ventures, receive on-ledger dividends, and vote on treasury moves.

## Run

```bash
npm install
npm start          # http://127.0.0.1:8471
```

First run seeds the database and prints the **admin** and **manager (marisol)**
sign-in credentials once. Delete `data/osmobank.db` to reseed. Set
`OSMO_ADMIN_PASS` / `OSMO_MANAGER_PASS` to choose them yourself.

```bash
npm test           # backend test suites (node:test)
```

## What's real

- **Auth & roles** — scrypt-hashed passphrases, server-side sessions
  (HttpOnly + SameSite=Strict cookies), roles `member / manager / admin`,
  profile + passphrase management, admin role assignment with
  last-admin protection and audit logging.
- **Wallets (client-side keys)** — BIP39 recovery phrases generated in the
  browser (audited noble/scure libraries); **BIP84 Bitcoin mainnet** (`bc1…`)
  + **Ethereum mainnet** (`0x…`) addresses. Send/receive is genuinely
  functional: UTXO selection + PSBT signing broadcast via mempool.space, EVM
  sends via a public mainnet RPC. The server stores watch-only addresses —
  keys never leave the device. Backup = encrypted file (PBKDF2 + AES-GCM)
  or on-device encrypted copy; restore = phrase or backup file.

  > ⚠️ **Real funds.** The wallet is on **mainnet** by default
  > (`public/js/wallet.js` → `NETWORK`). Derived addresses hold real Bitcoin
  > and Ethereum, and sends broadcast real, irreversible transactions. The
  > derivation is verified against the official BIP84 test vector and sends
  > are network-guarded (a mainnet wallet refuses a testnet recipient), but
  > **audit and dry-run with small amounts before trusting it with meaningful
  > value.** Set `NETWORK = 'testnet'` in `public/js/wallet.js` to exercise
  > the exact same flows on Bitcoin testnet + Ethereum Sepolia with zero risk.
- **Banking core** — internal USDC/OSM double-entry ledger: @handle
  transfers, venture investing (balance/min/target checks, atomic),
  pro-rata dividend & reimbursement distribution by venture managers,
  goals with funded balances, fundraiser contributions.
- **Investor's Edge & Reports** — computed from the real ledger: deployed,
  current value, P/L, allocation, 12-month series, dividend ledger,
  monthly statements, CSV export.
- **Governance** — OSM-weighted voting with quorum tracking.
- **Admin console** — live queues (listings, payouts, KYC), venture
  approval, dividend batch signing, member search + role/freeze controls.

New members are seeded with **12,450 demo USDC + 10 OSM** so the venture
economy is usable immediately. The gift-card store and a few ambient
numbers (price ticker, treasury décor) remain demo content.

## Funding a wallet

Send real BTC to your `bc1…` address or real ETH to your `0x…` address
(the Receive screen shows a scannable QR + address per chain). On `testnet`
mode, use a Bitcoin testnet / Sepolia faucet instead.

## Architecture

```
public/            no-build frontend — the design markup, byte-faithful
  index.html       shell (theme vars, modal, toast) + per-screen mounts
  partials/*.html  one file per screen (from the .dc.html design)
  app.js           core: router+guards, theme, toasts, modals, auth flows
  js/screens/*.js  per-screen hydrators (slots/lists → real API data)
  js/wallet.js     client-side keys: derive, backup, restore, sign, send
  vendor/          esbuild bundle of @scure/bip39+bip32+btc-signer, ethers
server/
  index.js         express bootstrap: CSP, CSRF origin check, sessions
  db.js            node:sqlite schema + deterministic seed
  routes/*.js      auth, wallets, ventures, portfolio, money, dao, admin, cards
  lib/util.js      validators, scrypt, sessions, rate limiting, lockout
  lib/mailer.js    provider-agnostic email (password-reset links)
  lib/smtp.js      zero-dependency SMTP client (implicit TLS / STARTTLS / AUTH)
tests/             node:test suites per module (real server, temp DB)
docs/CONTRACT.md   binding schema/API/slot contract
```

Design source: `OsmoBank App.dc.html` (claude.ai/design project
5c85fa15…). The original static demo behaviors are preserved wherever a
feature is intentionally demo-only.

## Email (password reset)

Reset delivery uses standard SMTP, so it works with **any provider** and sends
to **any recipient domain**. Copy `.env.example` to `.env` and set either a
`SMTP_SERVICE` preset (`gmail`, `hotmail`, `outlook`, `yahoo`, `icloud`,
`sendgrid`, `ses`, …) or an explicit `SMTP_HOST`/`SMTP_PORT`, plus
`SMTP_USER`/`SMTP_PASS` and `MAIL_FROM`. Gmail/Yahoo/iCloud need an
**app-specific password**. With nothing configured, local dev reveals the reset
link in-browser and the server never logs the token in production.
