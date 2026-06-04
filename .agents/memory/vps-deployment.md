---
name: VPS / CloudPanel deployment is single-port
description: How the app is hosted outside Replit — one Node process serves both the SPA and the API.
---

# VPS deployment runs as ONE process on a single port

On a self-hosted VPS (CloudPanel), the app is deployed as a **single Node process**, not
the two-process (Vite + API) split used in Replit dev. The Express API server
(`artifacts/api-server`) also serves the built frontend from
`artifacts/logesh-connect/dist/public` (static + SPA fallback for non-`/api`/`/uploads`/`/media`
GETs). The reverse proxy (CloudPanel or Nginx) forwards the whole domain to one app port.

**Why:** CloudPanel reverse-proxy sites point a domain at a single localhost port. Serving
the SPA from the API keeps it to one PM2 process and avoids a separate static host / second
port. The frontend uses relative `/api` paths (VITE_API_URL defaults to `/api`), so no base
URL config is needed behind the proxy.

**How to apply:**
- Deploy tooling lives at repo root: `deploy.sh`, `ecosystem.config.cjs`, `.env.example`,
  `nginx.conf.example`. `deploy.sh` builds api-server (esbuild) + frontend (vite), runs
  `@workspace/db run baseline` then `migrate` (versioned migrations), then PM2 (re)starts.
- Secrets are NOT committed: `ecosystem.config.cjs` reads them from `process.env`; `deploy.sh`
  loads a gitignored `.env`. `.env` and `logs/` are in `.gitignore`.
- PM2 `cwd` is set to `artifacts/api-server` so runtime `./uploads` and `../../attached_assets`
  resolve exactly as they do in dev. The frontend dist path is resolved from
  `import.meta.dirname` in `app.ts`, so it is cwd-independent.
- The static-serving branch only activates when `dist/public/index.html` exists; otherwise the
  server logs "API-only mode" and still serves `/api`.

**PORT / env changes need a full PM2 re-create, not `pm2 restart`.** `pm2 restart <app> --update-env`
reads env from the **current shell**, not from `.env` (only `deploy.sh` sources `.env` via `set -a; . .env`).
So editing `.env` then running a bare `pm2 restart` reuses PM2's *cached* env (e.g. stale `PORT`).
**Why:** caused a persistent `EADDRINUSE :::6000` crash-loop after changing PORT — the app kept binding the
old port. **How to apply:** `pm2 delete <app>; set -a; . ./.env; set +a; pm2 start ecosystem.config.cjs; pm2 save`
(or just re-run `bash deploy.sh`, which sources `.env` before restart). Port must be free of the VPS's other
apps; 5500 is the documented default. Avoid port 6000 — browsers reject it as an unsafe port (`ERR_UNSAFE_PORT`).

**Schema changes use versioned migrations** (not in-place `push`): edit schema, run
`@workspace/db run generate`, review + commit the `.sql` in `lib/db/migrations/`. Prod applies
them via `migrate`. `scripts/baseline.mjs` (idempotent, runs first in deploy) marks the `0000`
baseline as already-applied on legacy push'd DBs so existing tables/data are never re-created.
The drizzle migrator skips a migration when `drizzle.__drizzle_migrations.created_at >= journal
`when`; baseline just inserts that row (sha256 of the .sql + the journal `when`). Skip the whole
step with `SKIP_DB_MIGRATE=1 bash deploy.sh`.
