# The Flat Ledger

A shared-expenses app for a flatshare whose spreadsheet became a mess: mixed
date formats, duplicate rows, a settlement logged as an expense, dollar amounts
treated as rupees, and members who joined/left mid-stream. The app imports that
exact CSV, **detects and documents every data problem**, and produces clean,
explainable balances.

- **Live app:** https://the-flat-ledger-server-r93o.vercel.app
- **Stack:** React (Vite) · Node/Express · PostgreSQL (plain SQL via `pg`) · Neon · Vercel
- **AI collaborator:** Claude (Claude Code, model Opus 4.8). See [AI_USAGE.md](./AI_USAGE.md).

The five flatmate requests this app answers directly:

| Who | Ask | Where it's handled |
|-----|-----|--------------------|
| Aisha | "One number per person. Who pays whom." | Balances tab → net per person + "who pays whom" simplification |
| Rohan | "No magic numbers — show the expenses behind my balance." | Click any member in Balances → per-expense ledger with CSV row numbers |
| Priya | "A dollar isn't a rupee." | `fx.js` converts USD→INR at a documented rate; original + converted amounts both stored & shown |
| Sam | "Why would March electricity affect me? I joined mid-April." | Time-bounded membership: a member only splits expenses within `[joined_on, left_on]` |
| Meera | "Clean duplicates, but let me approve deletions/changes." | Every destructive action is logged as a `pending_approval` anomaly with approve/reject/resolve controls |

## Documentation map

- **[SCOPE.md](./SCOPE.md)** — the anomaly log (every CSV problem + how it's handled) and the database schema.
- **[DECISIONS.md](./DECISIONS.md)** — significant decisions, options considered, and why.
- **[AI_USAGE.md](./AI_USAGE.md)** — AI tools, key prompts, and concrete cases where the AI was wrong + how I caught it.
- **[docs/import_report.sample.txt](./docs/import_report.sample.txt)** — a real import report produced by the app on `expenses_export.csv`.

## Project structure

```
data/expenses_export.csv     the provided export (imported as-is, never hand-edited)
server/
  db/schema.sql              relational schema (the source of truth)
  db/pool.js                 pg connection pool + transaction helper
  src/lib/                   money / fx / dates / names  (the tricky bits, unit-tested)
  src/import/                CSV parser, split engine, anomaly detection, report, roster
  src/balances/compute.js    net balances, debt simplification, per-member ledger
  src/routes/                auth, groups, members, expenses, balances, settlements, imports
  scripts/                   db-reset, import CLI
  tests/                     node:test unit tests
client/                      React + Vite SPA
api/index.js                 Vercel serverless entry (wraps the same Express app)
```

## Run it locally

Prerequisites: Node 18+ and a PostgreSQL database (local or a Neon URL).

```bash
# 1. install
npm install

# 2. configure the DB
cp server/.env.example server/.env
#   edit server/.env -> set DATABASE_URL (and a JWT_SECRET)

# 3. create the schema
npm run db:reset

# 4. (optional) import the CSV from the command line and print the report
npm run import:csv

# 5. run the app (API on :4000, web on :5173)
npm run dev
```

Open http://localhost:5173, create an account, click **Create demo group "Flat 4B"**,
go to the **Import & Anomalies** tab, and upload `data/expenses_export.csv`.

### Tests

```bash
npm test    # money (largest-remainder, parsing), dates, split engine
```

## Deploy (Vercel + Neon)

1. **Create a Neon Postgres database.** Copy the **pooled** connection string
   (it contains `-pooler`), which ends with `?sslmode=require`.
2. **Apply the schema** to Neon once:
   ```bash
   DATABASE_URL="postgres://...neon.tech/neondb?sslmode=require" npm run db:reset
   ```
3. **Import this repo into Vercel.** Vercel auto-detects `vercel.json`:
   - build command `npm run build`, output `client/dist`
   - `/api/*` is routed to the serverless function in `api/index.js`
4. **Set Vercel environment variables** (Production):
   - `DATABASE_URL` = your Neon pooled URL
   - `JWT_SECRET` = a long random string
   - `CLIENT_ORIGIN` = your deployed URL (e.g. `https://your-app.vercel.app`)
   - `NODE_ENV` = `production`
5. Deploy. Visit the URL, register, create the demo group, import the CSV.

> Why Neon's **pooled** endpoint: serverless functions open many short-lived
> connections; the pooler (PgBouncer) keeps that within Postgres' connection
> limit. See DECISIONS.md.
