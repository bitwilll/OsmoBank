# Deploying OsmoBank to Vercel + osmobank.com

The app is a static frontend (`public/`) served by Vercel's CDN plus one Express
serverless function (`api/index.js`) handling `/api/*`. State lives in a hosted
**Turso** (libSQL) database — Vercel's filesystem is ephemeral, so a local SQLite
file would lose all data between requests.

Already done in this repo:
- Data layer migrated to async libSQL (`server/db.js`); 98/98 tests pass.
- Serverless wrapper (`api/index.js`) + routing (`vercel.json`).
- Project linked to the `osmo` Vercel project; `vercel build` validated.
- Public env vars set on the project: `OSMO_ORIGIN`, `OSMO_RP_ID`.

## Steps that require your credentials (Claude can't enter tokens/passwords)

### 1. Create a Turso database
```bash
# one-time: install + sign in (opens browser)
brew install tursodatabase/tap/turso   # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth login

turso db create osmobank
turso db show osmobank --url                 # -> TURSO_DATABASE_URL
turso db tokens create osmobank              # -> TURSO_AUTH_TOKEN
```

### 2. Add env vars to the Vercel `osmo` project
In the Vercel dashboard (Project → Settings → Environment Variables, **Production**),
or via CLI (`vercel env add <NAME> production`):

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://osmobank-<you>.turso.io` |
| `TURSO_AUTH_TOKEN` | the token from step 1 |
| `OSMO_ADMIN_PASS` | a strong operator password you choose |
| `OSMO_MANAGER_PASS` | a strong manager password you choose |
| `SMTP_*` (optional) | see `.env.example` — enables password-reset emails |

`OSMO_ORIGIN` and `OSMO_RP_ID` are already set. `NODE_ENV=production` is automatic.

### 3. Seed the database (once)
```bash
# with the two Turso vars + the two OSMO_*_PASS exported locally:
npm run db:migrate
```
(Optional — the app also self-initialises the schema and seed on first request.)

### 4. Deploy to production + attach the domain
```bash
vercel deploy --prod            # builds with the env vars above
vercel domains add osmobank.com osmo   # if not already attached
```
`osmobank.com` already resolves to Vercel's nameservers, so it goes live once the
production deployment is promoted. Claude can run this step for you **after** the
env vars in step 2 exist (it needs no secrets — they live in the project).

## Notes
- Rate-limit / lockout counters are in-memory (per serverless instance), so they
  are best-effort across instances. Sessions, ledger, cards, etc. are all in Turso.
- The wallet is on **mainnet** — it derives and spends real BTC/ETH.
