# OsmoBank — Implementation Contract

Single source of truth for the database schema, REST API, and conventions.
Every module MUST follow this exactly. If something is ambiguous, follow the
patterns in `server/routes/auth.js` (the exemplar route module).

## Stack & conventions

- Node 22, ESM (`"type": "module"`), Express 4, `node:sqlite` (`DatabaseSync`).
- DB handle: `import { db } from '../db.js'` — synchronous prepared statements.
- Route modules export `export default function mount(app)` and are mounted by
  `server/index.js`. Paths are absolute (`/api/...`) inside each module.
- Auth middleware from `../lib/util.js`:
  - `requireAuth` — 401 if no valid session; sets `req.user` (full user row, no pass).
  - `requireRole('admin')` / `requireRole('admin','manager')` — 403 otherwise.
- Validation helpers from `../lib/util.js`: `str(v, {min, max})`, `num(v, {min, max})`,
  `oneOf(v, [...])` — throw `ApiError(400, message)` on failure.
- Errors: `throw new ApiError(status, message)`; the global error handler renders
  `{ error: message }`. Never leak stack traces or SQL.
- All handlers that write data MUST be wrapped in `tx(() => { ... })` from db.js
  when they touch more than one table.
- Money: REAL dollars in ledger (2dp rounding via `round2()` util). OSM voting
  power: integer.
- Every admin/manager mutation writes `audit(actorId, action, subject, detail)`.
- IDs in URLs are integers — validate with `num()`.
- JSON responses: camelCase keys.

## Database schema (server/db.js creates this)

```sql
users(id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL,      -- '@amara' stored WITHOUT '@' as 'amara'
      name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      pass TEXT NOT NULL,                                        -- 'scrypt:<salthex>:<hashhex>'
      role TEXT NOT NULL DEFAULT 'member',                       -- member|manager|admin
      status TEXT NOT NULL DEFAULT 'active',                     -- active|review|frozen
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL)
wallets(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      chain TEXT NOT NULL,                                       -- btc-testnet|eth-sepolia|btc|eth|sol|usdc
      address TEXT NOT NULL, label TEXT,
      kind TEXT NOT NULL DEFAULT 'hd',                           -- hd|imported|watch
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, chain, address))
ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDC',                     -- USDC|OSM
      delta REAL NOT NULL,                                       -- + credit, - debit
      kind TEXT NOT NULL,   -- seed|invest|exit|dividend|reimbursement|transfer_in|transfer_out|contribution|adjust
      ref_type TEXT, ref_id INTEGER, memo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
ventures(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL,
      blurb TEXT NOT NULL DEFAULT '', apy REAL NOT NULL,
      min_amount REAL NOT NULL DEFAULT 100, target_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',                    -- pending|active|closed|rejected
      manager_id INTEGER,                                        -- users.id with role manager/admin
      badge TEXT,                                                -- e.g. 'SERIES B IN VOTE', 'NEW LISTING'
      payout_freq TEXT NOT NULL DEFAULT 'quarterly',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
investments(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      venture_id INTEGER NOT NULL, amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',                     -- active|exited
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
payouts(id INTEGER PRIMARY KEY, venture_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                                        -- dividend|reimbursement
      total REAL NOT NULL, memo TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
payout_items(id INTEGER PRIMARY KEY, payout_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, amount REAL NOT NULL)
goals(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'SAVINGS',
      icon TEXT NOT NULL DEFAULT 'flag',
      target REAL NOT NULL, saved REAL NOT NULL DEFAULT 0,
      autosave REAL NOT NULL DEFAULT 0, eta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
transfers(id INTEGER PRIMARY KEY, from_user INTEGER,             -- NULL for external inbound
      to_user INTEGER,                                           -- NULL for external outbound
      chain TEXT NOT NULL DEFAULT 'internal',                    -- internal|btc-testnet|eth-sepolia|...
      to_address TEXT,                                           -- @handle (no @) or on-chain address
      currency TEXT NOT NULL DEFAULT 'USDC', amount REAL NOT NULL,
      txid TEXT, status TEXT NOT NULL DEFAULT 'settled',         -- settled|broadcast|failed
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
proposals(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL,     -- 'OSM-042'
      title TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'live',                       -- live|passed|rejected
      quorum_pct REAL NOT NULL DEFAULT 30, ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
votes(proposal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      support INTEGER NOT NULL,                                  -- 1 FOR / 0 AGAINST
      power REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (proposal_id, user_id))
fundraisers(id INTEGER PRIMARY KEY, venture_id INTEGER NOT NULL,
      title TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '',
      target REAL NOT NULL, raised REAL NOT NULL DEFAULT 0,
      backers INTEGER NOT NULL DEFAULT 0, apy REAL NOT NULL,
      min_amount REAL NOT NULL DEFAULT 100,
      ends_at TEXT, status TEXT NOT NULL DEFAULT 'open')         -- open|closed
audit_log(id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL,
      subject TEXT, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
```

Balance of a user = `SELECT COALESCE(SUM(delta),0) FROM ledger WHERE user_id=? AND currency=?`
(helper `balance(userId, currency)` exported by db.js). Debits MUST check
sufficient balance inside the same transaction.

New members are seeded (by auth/register): +12450 USDC kind `seed`, +10 OSM kind `seed`.

## REST API

All endpoints JSON. Session cookie `ob_sess` (HttpOnly, SameSite=Strict).
State-changing requests are rejected unless `Origin` is same-origin (handled
globally in index.js — modules don't re-check).

### auth (exemplar — already implemented)
- `POST /api/auth/register` `{name, handle, email, passphrase}` → `{user}` (session set; seeds balances; handle stored lowercase without @; passphrase ≥ 12 chars)
- `POST /api/auth/login` `{identifier, passphrase}` → `{user}` (identifier = email or handle)
- `POST /api/auth/logout` → `{ok: true}`
- `GET /api/me` → `{user: {id,name,handle,email,role,status,createdAt}, balances: {USDC, OSM}}` (requireAuth)
- `PATCH /api/me` `{name?, email?}` → `{user}` (requireAuth)
- `POST /api/me/passphrase` `{current, next}` → `{ok}` (requireAuth; verifies current)

### wallets — server/routes/wallets.js
- `GET /api/wallets` (auth) → `{wallets: [{id, chain, address, label, kind, createdAt}]}`
- `POST /api/wallets` (auth) `{chain, address, label?, kind?}` → `{wallet}` — registers a
  CLIENT-derived address (watch-only registry; server never sees keys).
  Valid chains: btc-testnet, eth-sepolia, btc, eth, sol, usdc. Address max 128 chars,
  basic shape check per chain (btc*: bech32/base58 charset; eth*: 0x + 40 hex; sol: base58 32-44).
- `PATCH /api/wallets/:id` (auth, own wallet) `{label}` → `{wallet}`
- `DELETE /api/wallets/:id` (auth, own wallet) → `{ok}`

### ventures + investing + payouts — server/routes/ventures.js
- `GET /api/ventures` (auth) → `{ventures: [...]}` each: `{id, name, sector, blurb, apy,
  minAmount, targetAmount, raised, filledPct, status, badge, managerId, payoutFreq,
  youHold}` — `raised` = SUM active investments; `youHold` = caller's active stake.
  Members see status IN ('active','closed'); managers/admins also see 'pending'/'rejected'.
- `POST /api/ventures` (manager|admin) `{name, sector, blurb, apy, minAmount, targetAmount, payoutFreq?}`
  → `{venture}` (status 'pending'; manager_id = creator; admins may pass managerId)
- `POST /api/ventures/:id/invest` (auth) `{amount}` → `{investment, balance}` —
  venture must be 'active'; amount ≥ min_amount; caller USDC balance ≥ amount;
  ledger: -amount kind 'invest' ref venture; insert investments row. All in tx.
- `POST /api/ventures/:id/exit` (auth) → `{ok, returned}` — marks caller's active
  investments in that venture 'exited', credits ledger +stake kind 'exit'.
- `POST /api/ventures/:id/payouts` (venture manager or admin) `{kind, total, memo?}` —
  kind dividend|reimbursement; total > 0; distributes PRO-RATA across active
  investments by stake share, 2dp; remainder cents go to the largest stakeholder;
  writes payouts + payout_items + ledger credits kind = payout kind. → `{payout, items}`
- `GET /api/ventures/:id/payouts` (auth) → `{payouts: [{id, kind, total, memo, createdAt, yourShare}]}`

### portfolio + reports — server/routes/portfolio.js
- `GET /api/portfolio` (auth) → `{deployed, currentValue, netPl, netPlPct, nextDividend:
  {amount, date, venture} | null, positions: [{ventureId, name, sector, stake, valueNow,
  pl, plPct, apy, dividendsPaid}], allocation: [{name, pct}], series: [{month, value}],
  diversification: {score, sectors}}`
  - `valueNow` = stake + accrued dividends received for that venture.
  - `series` = last 12 months of (deployed + cumulative dividends) snapshots from ledger history.
- `GET /api/reports` (auth) → `{netWorthYtd, netWorthYtdPct, dividendsYtd, feesYtd,
  receiptsFiled, dividendLedger: [{venture, quarter, amount, status, date, txref}],
  statements: [{month, txCount, sizeMb}]}` — statements = ledger rows grouped by month.
- `GET /api/reports/export` (auth) → CSV of caller's ledger (Content-Type text/csv).

### goals + transfers — server/routes/money.js
- `GET /api/goals` (auth) → `{goals: [...]}` with `pct` computed
- `POST /api/goals` (auth) `{name, category?, icon?, target, autosave?}` → `{goal}`
- `PATCH /api/goals/:id` (auth, own) `{name?, target?, autosave?, addSaved?}` → `{goal}`
  (`addSaved` debits USDC ledger kind 'adjust' memo 'goal contribution', credits goal.saved)
- `DELETE /api/goals/:id` (auth, own) → `{ok}` (refunds saved to ledger kind 'adjust')
- `POST /api/transfers` (auth) `{to, amount, currency?}` — `to` = @handle (with or
  without @). Internal instant settle: debit sender kind 'transfer_out', credit
  recipient kind 'transfer_in', insert transfers row. Cannot send to self. → `{transfer, balance}`
- `POST /api/transfers/record` (auth) `{chain, txid, toAddress, amount, currency}` —
  records an EXTERNAL on-chain send that the CLIENT signed & broadcast (status 'broadcast').
  Validates txid shape (hex 8..128). No ledger movement (on-chain funds are not ledger funds). → `{transfer}`
- `GET /api/transfers` (auth) → `{transfers: [...]}` newest first, both directions,
  with counterparty handle when internal.

### governance + fundraiser — server/routes/dao.js
- `GET /api/proposals` (auth) → `{proposals: [{id, code, title, blurb, status, forPct,
  againstPct, voters, quorumPct, quorumReached, endsAt, yourVote}]}` (live first, then recent)
- `POST /api/proposals/:id/vote` (auth) `{support}` (bool) — power = caller OSM balance;
  one vote per user per proposal (re-vote replaces). → `{proposal}`
- `GET /api/fundraiser` (auth) → `{fundraiser: {id, title, blurb, target, raised, backers,
  pct, apy, minAmount, daysLeft, hoursLeft, useOfFunds: [...], updates: [...],
  ventureName, proposalCode, proposalForPct}}` (the single open one; static useOfFunds/updates ok)
- `POST /api/fundraiser/contribute` (auth) `{amount}` — amount ≥ minAmount, balance check,
  ledger -amount kind 'contribution', fundraiser.raised += amount, backers += 1 (first time). → `{fundraiser, balance}`

### admin — server/routes/admin.js  (ALL require role admin, except where noted)
- `GET /api/admin/overview` → `{members, membersThisWeek, treasury, volume24h, transfers24h,
  needsAction: {listings, payoutsDue, kyc}, listingQueue: [{ventureId, name, blurb, status}],
  payoutQueue: [{ventureId, name, due, estTotal, holders}], newestMembers: [{id, handle,
  role, memberNo, joinedAgo, kyc, status}], network: {block, latencyMs, uptimePct, signers}}`
  (treasury = SUM of all USDC ledger; network stats may be synthesized deterministically)
- `GET /api/admin/users?q=` → `{users: [{id, name, handle, email, role, status, createdAt, balance}]}`
- `PATCH /api/admin/users/:id` `{role?, status?}` — assign managers/roles. Cannot demote
  the last admin. Audit-logged. → `{user}`
- `POST /api/admin/ventures/:id/approve` → sets status 'active'; optional `{managerId}` to
  assign a manager (validates target user has role manager|admin). Audit-logged. → `{venture}`
- `POST /api/admin/ventures/:id/reject` → status 'rejected'. → `{venture}`
- `GET /api/admin/audit?limit=` → `{entries: [...]}` newest first (admin OR manager).

## Frontend hydration slots

`public/index.html` carries `data-slot="<name>"` attributes on the elements whose
text/content the hydrators replace, and `data-list="<name>"` on containers whose
children are templated (first child = template, cloned per item). Slot names are
namespaced per screen: `dash.totalAssets`, `wallets.list`, `edge.deployed`, etc.
Screen hydrator modules live in `public/js/screens/<screen>.js` and export
`export async function hydrate(root, ctx)` where ctx = `{api, me, fmt, toast, nav, wallet}`.

## Security requirements (all modules)

- Parameterized SQL ONLY (prepared statements). String concatenation into SQL is a defect.
- Ownership checks on every :id route (user can only touch own rows unless admin).
- All numeric inputs validated + range-checked; amounts > 0; 2dp rounding.
- No secrets in responses (pass, session tokens of others, other users' emails from
  non-admin endpoints).
- DOM: hydrators use textContent, never innerHTML with user data.

## New endpoints — security, cards, export (added post-v1)

### security — server/routes/security.js (all requireAuth unless noted)
- `GET /api/security` → `{ twoFactorEnabled, twoFactorPending, passkeys: [{id, label, createdAt, lastUsedAt}] }`
- `POST /api/security/2fa/setup` → `{ secret, otpauthUri }` (creates a pending TOTP secret; not yet enforced)
- `POST /api/security/2fa/enable` `{code}` → verifies the 6-digit TOTP, enables 2FA → `{ok, ...status}`
- `POST /api/security/2fa/disable` `{code?|passphrase?}` → re-auth then disable → `{ok, ...status}`
- `POST /api/security/passkey/register/options` → WebAuthn registration options (challenge stored)
- `POST /api/security/passkey/register/verify` `{response, label?}` → verifies + stores passkey → `{ok, ...status}`
- `DELETE /api/security/passkey/:id` (own) → `{ok, ...status}`

### auth additions — server/routes/auth.js
- `POST /api/auth/login` now: if the user has 2FA enabled and no/invalid `totpCode`, returns 401 `{error, twoFactorRequired:true}`; resubmit with `{identifier, passphrase, totpCode}`.
- `POST /api/auth/passkey/login/options` (no auth) `{identifier?}` → WebAuthn auth options (+ ob_pk challenge cookie)
- `POST /api/auth/passkey/login/verify` (no auth) `{response}` → verifies assertion, creates session → `{user}`

### cards — server/routes/cards.js (all requireAuth)
- `GET /api/cards` → `{ cards:[{id,label,brand,last4,exp,kind,frozen,dailyLimit,createdAt}], spend, spendBreakdown:{groceries,transit,dining} }`
- `POST /api/cards` `{label?, brand?(OSMO|VISA|MC), kind?}` → `{card}` (max 8; every new member is auto-issued one at signup)
- `PATCH /api/cards/:id` (own) `{frozen?, label?, dailyLimit?}` → `{card}`
- `POST /api/cards/:id/reveal` (own) `{passphrase}` → `{pan, cvv, exp}` (passphrase-gated, audit-logged)
- `DELETE /api/cards/:id` (own) → `{ok}`
- `POST /api/cards/gift` `{brand(AURORA AIR|SOLACE COFFEE|CITY TRANSIT|PLAYFIELD), amount}` → debits USDC ledger → `{gift:{id,brand,amount,code,back}, balance}`
- `GET /api/cards/gifts` → `{gifts:[...]}`

### export — server/routes/portfolio.js
- `GET /api/reports/export?format=csv|pdf` → CSV (raw ledger) or PDF (formatted account statement)
- `GET /api/portfolio/export?format=csv|pdf` → CSV or PDF of the Investor's Edge positions/P&L

## Clean-slate accounts, deposits & activity (added post-v1)
New members start with a **genuine zero balance** — no demo "founding balance", positions, activity, goals, or referral stats. Screens show real data or honest empty states. Members fund themselves:
- `POST /api/deposits` (auth) `{amount(0.01–250000), currency?(USDC|OSM), method?(bank|card|wire)}` → posts a `deposit` ledger row → `{deposit:{id,currency,amount,method}, balance}`. Counts toward net worth exactly like the retired `seed` kind.
- `GET /api/activity` (auth) → `{activity:[{id,kind,currency,delta,memo,createdAt}]}` — last 8 ledger movements, newest first (dashboard feed).

## Forgot / reset passphrase — SOC-style controls (added post-v1)
- `POST /api/auth/forgot` (no auth, rate-limited) `{identifier}` → **always** `{ok:true}` regardless of whether the account exists (no user enumeration; response timing is equalised across both branches). If it exists and no token was issued within a 60s per-account cooldown, a single-use token is minted; only its **SHA-256 hash** is stored (`password_resets`). In **production the raw token is never logged** (only a `user:<id>` reference is) and is delivered out of band by **email over SMTP** (`server/lib/mailer.js` + `server/lib/smtp.js`; provider-agnostic, configured via `SMTP_*` env — see `.env.example`); in **local dev** (`OSMO_SECURE_COOKIES` unset) the response also carries `{devToken, devResetUrl}` and the link is logged, so the in-browser flow works without a mail server. Prior tokens are **not** invalidated on mint (so an attacker can't grief a victim's live token); they are cleared on a completed reset or passphrase change.
- `POST /api/auth/reset` (no auth, rate-limited) `{token, next(≥12)}` → validates a live, unused, unexpired token inside a transaction, rotates the passphrase (scrypt), marks the token used (single-use), and **revokes every session** for that user. Does not sign the user in. Invalid/expired/reused token → 400.

## Sessions & single-active-session (added post-v1)
`sessions` gained `last_seen`, `user_agent`, `ip` (idempotent migrations). `loadSession` sets `req.sessionToken` and heartbeats `last_seen` (≤ once/60s). A session is "live" if seen within `LIVE_WINDOW_SEC` (120s).
- `GET /api/me` now also returns `session: {total, others, othersLive}` — count of the caller's other sessions and how many are currently live. The landing page shows the **Dashboard** button only when signed in and `othersLive === 0`; otherwise it warns and offers to sign the other devices out. The lock is enforced in the **client router `guard()`** (not just by hiding the button): member screens redirect to `home` while `othersLive > 0`.
- `GET /api/sessions` (auth) → `{sessions:[{current, userAgent, ip, createdAt, lastSeen, live}]}` (a "your devices" view).
- `POST /api/auth/logout-all` (auth) → revokes every **other** session, keeping the current one → `{ok, revoked}`.
- `POST /api/me/passphrase` still rotates the passphrase and re-issues only the caller's session (all others dropped).

## Mobile-wallet provisioning — Apple / Google / Samsung Pay (added post-v1)
Simulated issuer side of push-provisioning (no real Visa VTS / Mastercard MDES or native app; responses carry `simulated:true`). The wallet receives a DPAN-style **token reference**, never the real PAN.
- `GET /api/cards` now attaches `wallets:[{platform, wallet, tokenRef, status, addedAt}]` per card (scoped to the caller).
- `POST /api/cards/:id/provision` (own card) `{platform(apple|google|samsung), device?}` → mints/refreshes the token reference (unique per card+platform; blocked if the card is frozen) → `{platform, wallet, tokenRef, card:{last4,brand}, simulated:true}`.
- `DELETE /api/cards/:id/provision/:platform` (own card) → removes the card from that wallet → `{ok}`. Deleting a card also drops its wallet provisions.

## Support / Contact-us (added post-v1) — server/routes/support.js
- `POST /api/support` (public, rate-limited) `{category(account|payments|security|password_reset|troubleshooting|other), message, email?, handle?}` → raises a ticket → `{ok, ref}`. If signed in, the caller's user/email/handle are attached automatically.
- `GET /api/admin/support?status=open|closed|all&limit=` (admin/manager) → `{tickets:[{id,userId,userHandle,email,category,message,source,status,createdAt}], openCount}`.
- `PATCH /api/admin/support/:id` (admin/manager) `{status(open|closed)}` → `{ok}`.
- `POST /api/auth/forgot` also raises a **system** ticket (`category:'password_reset', source:'system'`) so operators see every reset request. Rendered as an injected inbox panel on the admin console.

## Self-service account recovery (added post-v1) — server/routes/auth.js
No email required — prove ownership, then receive a single-use `resetToken` for `POST /api/auth/reset`.
- `POST /api/auth/recover/card` `{identifier, pan, exp, cvv}` → verifies the full card number + expiry + CVV against a stored OsmoBank card (per-account lockout via the shared `recover:` key) → `{ok, resetToken}`.
- `POST /api/auth/recover/challenge` `{}` → `{nonce}` (single-use, 5-min TTL, stored in `webauthn_challenges` with purpose `recover`).
- `POST /api/auth/recover/seed` `{identifier, nonce, signature}` → the client signs the nonce with the wallet's Ethereum key (`wallet.signChallenge`); the server `verifyMessage`s it and checks the recovered address is one anchored to the account (`wallets` where `chain='eth'`, registered at signup) → `{ok, resetToken}`. The mnemonic never leaves the browser.
