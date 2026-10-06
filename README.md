# Big Star VDP — API server

Express + MongoDB API for the Big Star VDP Management System. It owns every calculation and serves
the data used by the web client (`../client`). Models and endpoints are described in
`../ARCHITECTURE.md`, and calculation rules in `../BUSINESS_RULES.md`.

## Setup

```bash
npm install
# create server/.env (see Environment below); MONGO_URI is required
npm run seed   # DIV 10, Night/Day plans, current DIV 10 roster (idempotent)
npm run dev    # http://localhost:5000, restarts on change (or: npm start)
```

All routes are under `/api`. When `../client/build` exists, the server also serves the built client
on the same port.

## Environment

Settings are read from `server/.env`, which is git-ignored.

| Variable | Default | Purpose |
|---|---|---|
| `MONGO_URI` | — | **Required.** MongoDB connection string |
| `MONGO_DB_NAME` | `bigstar_vdp` | Database inside the `MONGO_URI` cluster |
| `JWT_SECRET` | dev-only value | Signs session cookies. **Required in production** |
| `PORT` | `5000` | API port |
| `NODE_ENV` | — | `production` requires `JWT_SECRET` and sends the session cookie over HTTPS only |
| `CLIENT_ORIGIN` | Built-in localhost and production origins | Additional client address(es) allowed by CORS, comma-separated, e.g. `https://admin.example.com,https://vdp.example.com` |
| `COOKIE_SAME_SITE` | `lax` | Set to `none` when the client is hosted on a different site than the API. This also makes the cookie HTTPS-only |
| `COMPASS_BASE_URL` | — | Compass API origin, for example `https://compass.example.com` |
| `COMPASS_API_TOKEN` | — | Read-only Compass access token; keep only in local/deployment secrets |
| `COMPASS_TIMEOUT_MS` | `20000` | Timeout for each fixed Compass GET request |

When the client is served by this API (same origin), the defaults are enough.

### Compass roster synchronization

When the Compass connection is configured, Compass becomes the authority for divisions, providers,
operators, active status, routes, vehicles, and weekly contracted hours. Contracted hours are the
sum of each active run cut's `serviceHours` multiplied by its distinct scheduled weekdays. Manual division/provider creation and bulk roster
imports are disabled. MongoDB remains the application database for VDP plans, rates, overrides,
lift leases, contact details, notes, statements, and payment history.

Administrators set **Automatic refresh** and **Refresh every (minutes)** on the Settings page; these
values are stored in MongoDB and take effect without a redeploy. **Sync now** performs an immediate
refresh. The server calls only fixed Compass GET endpoints, validates the complete snapshot before
changing roster records, and never returns the API token to the client. Divisions absent from a
successful Compass response are left untouched, so a MongoDB-only division such as DIV 12 is not
deactivated. Keep the token in deployment environment variables, not in source control.

Compass does not supply lift-lease pricing. The **Lift Leases** tab lists the Compass divisions and
lets an administrator assign one weekly, per-cycle, or no-lease price to every operator/pay unit in
a division. The value is stored on the division in MongoDB, applied to current operators, and copied
to new operators during later Compass refreshes. Open VDPs are marked stale; approved and paid
statements keep their frozen values.

The **Plan Assignments** tab applies one active VDP plan to every provider in a division and saves it
as the default for providers discovered by later Compass refreshes. A provider can be edited afterward
to choose another plan as an explicit exception. Routine refreshes preserve exceptions; deliberately
applying the division plan again replaces them. Plan assignments remain MongoDB-owned.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Start the API |
| `npm run dev` | Start with nodemon (restarts on file changes) |
| `npm run seed` | Load the base division, plans and roster (safe to run again) |
| `npm run import:json -- <folder> --uri "<MONGO_URI>" [--db name] [--drop]` | Load an Extended JSON export (one `<collection>.json` per collection) into a database, keeping ObjectIds, dates and decimals. Collections that already have data are skipped unless `--drop` is given |
| `npm run test:engine` | Calculation engine, parser, cycles and plans (no database needed) |
| `npm test` | Everything, including end-to-end API tests on the `bigstar_vdp_test` database |

## Layout

| Path | Contents |
|---|---|
| `server.js` | Entry point: loads `.env`, connects to MongoDB, starts listening, runs VDP auto-approval and the Compass roster scheduler |
| `src/app.js` | Express app: security headers, CORS, routes, client build |
| `src/config/` | Database connection |
| `src/controllers/`, `src/routes/` | HTTP handlers |
| `src/services/` | Business logic (calculations, imports, VDPs, PDFs, reports) |
| `src/models/` | Mongoose models |
| `src/middleware/` | Auth (session cookie), errors |
| `scripts/seed.js` | Seed data |
| `scripts/importJson.js` | Import a JSON export into another database |
| `test/` | Node test runner suites |
