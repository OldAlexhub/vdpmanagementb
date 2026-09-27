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
| `CLIENT_ORIGIN` | `http://localhost:3000` | Client address(es) allowed by CORS, comma-separated, e.g. `http://localhost:3000,https://vdp.example.com` |
| `COOKIE_SAME_SITE` | `lax` | Set to `none` when the client is hosted on a different site than the API. This also makes the cookie HTTPS-only |

When the client is served by this API (same origin), the defaults are enough.

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
| `server.js` | Entry point: loads `.env`, connects to MongoDB, starts listening, runs VDP auto-approval every 5 minutes |
| `src/app.js` | Express app: security headers, CORS, routes, client build |
| `src/config/` | Database connection |
| `src/controllers/`, `src/routes/` | HTTP handlers |
| `src/services/` | Business logic (calculations, imports, VDPs, PDFs, reports) |
| `src/models/` | Mongoose models |
| `src/middleware/` | Auth (session cookie), errors |
| `scripts/seed.js` | Seed data |
| `scripts/importJson.js` | Import a JSON export into another database |
| `test/` | Node test runner suites |
