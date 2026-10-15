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

Compass does not supply lift-lease pricing. The **Lift Leases** tab supports any number of named,
division-scoped weekly, per-cycle, or no-lease options. Adding an option does not assign it; an
administrator explicitly selects it for an operator on the provider edit screen. Compass divisions
can also have a fallback default for operators without an explicit option. Saved option assignments
survive later Compass refreshes, while new operators inherit the fallback. Editing an assigned option
or the applicable default marks open VDPs stale; approved and paid statements keep frozen values.

## VDP processing pipeline

Processing starts with a division/program and a generated pay period, then moves through required datasets, additional datasets,
validation/calculation, and VDP review. A Performance Report or Uber dataset may be uploaded with
the division only; the server infers the pay period from source dates and binds the import to the
single generated cycle containing all dates. It refuses ambiguous, cross-period, or unmatched date
ranges. The additional-data stage is intentionally ready for division-specific requirements without
assuming toll, fare, or other feeds before those divisions are configured.

### Compass performance and corrections

Opening a processing period as an Accounting-authorized user attempts its first Compass performance
import. Later updates use **Refresh from Compass** in VDP Management; performance has no scheduler.
The integration reuses the roster connection settings above and only sends GET requests to Compass.
It fetches `/api/network-success/entries` separately for each inclusive date, source, and linked
division external ID, and uses `/api/network-success/performance` for assignment and reconciliation.
A 2,000-entry response, invalid response, or mismatch rejects the refresh and retains the prior snapshot.
Empty dates remain visibly missing. Shared-route components are counted once without parent totals.

Versioned `PerformanceImport` records (`kind: COMPASS`) and bounded `NormalizedFact` records preserve
source IDs, original metrics, checksums, date coverage and retrieval time. `CompassPerformanceState`
holds each cycle's active snapshot pointer, revision, update lock, and separately audited corrections.
Identical imports reuse the snapshot and do not mark statements stale. Materialized Compass metrics
are tagged so that older derived imports cannot masquerade as uploaded fallback after a refresh.

Metrics resolve as **manual correction → Compass → uploaded fallback**, never by adding overlapping
sources. Supplemental file fields remain available when they can be assigned unambiguously. Only
performance source slots whose complete required inputs are supplied become optional; mileage,
manifest/duty details, TUI window hours, fares, fuel and toll requirements remain. Service hours never
replace total paid hours or duty/TUI hours. Negative upstream hours are preserved for reconciliation,
flagged in review, and cannot be used as payable hours; unaffected metrics remain usable.

Accounting-authorized users can correct completed trips, service hours, or a record's dated operator
assignment. Every change, retain, and revert requires a nonblank reason and the current revision.
Trips must be nonnegative whole numbers; corrected hours must be nonnegative decimals. Corrections
survive refreshes. Changed source values or removed corrected records block approval until reviewed.
Explicitly keeping a removed record retains its work locally; reverting removes that local correction.
Changes mark editable statements stale. Approved and paid statements keep their frozen snapshots and
must follow the existing reopening workflow before their corrections can be changed.

| Cycle-scoped endpoint (under `/api`) | Purpose |
|---|---|
| `GET /cycles/:cycleId/compass-performance` | Coverage, refresh status, daily source/effective values, issues and correction history |
| `POST /cycles/:cycleId/compass-performance/sync` | Refresh with `{ expectedRevision }` |
| `POST /cycles/:cycleId/compass-performance/corrections` | `{ expectedRevision, rowKey, action, reason, values?, assignment? }`; action is `CORRECT`, `RETAIN`, or `REVERT` |

Both mutation endpoints use the existing Accounting authorization. The integration does not write
to Compass, automatically recalculate historical statements, or change compensation plan definitions.

On the **Providers** tab, administrators can filter to a division and batch assign one of that
division's existing active VDP plans. The selection also becomes the default for providers discovered
by later Compass refreshes. An individual provider can still be edited afterward to use another plan.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Start the API |
| `npm run dev` | Start with nodemon (restarts on file changes) |
| `npm run seed` | Load the base division, plans and roster (safe to run again) |
| `npm run bootstrap:production` | Seed a clean production database with blueprints, source contracts, settings, and the current Compass roster; refuses a populated database |
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
