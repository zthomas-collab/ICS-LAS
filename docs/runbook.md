# Deployment & Operations Runbook

> Status: development slice. Sections marked **UNTESTED** describe the intended procedure and must be rehearsed before production.

## Local development

```bash
npm install
npm run db:seed                 # creates .data/pglite, applies migrations, loads [SYNTHETIC] data
npm run admin:grant -- you@example.test PLATFORM_ADMIN "local bootstrap"
npm run dev                     # http://localhost:3000 ; emails appear at /dev/outbox
npm run check                   # lint + typecheck + tests (in-memory PostGIS)
npm run zips:import -- 2024_Gaz_zcta_national.txt   # optional: ZIP centroids for Contacts radius search
```
PGlite is single-process: stop `npm run dev` before running `db:*`/`admin:*` scripts. Reset local data by deleting `.data/`.

## Configuration

| Variable | Required in prod | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL 16+ / PostGIS 3.4+ connection (app login role, not owner) |
| `APP_BASE_URL` | ✅ | Absolute URL used in emailed links |
| `MIGRATE_ON_START` | — | `true` to migrate at boot (prefer a one-off migration job) |
| `DB_POOL_MAX` | — | Pool size per instance (default 10) |
| `NEXT_PUBLIC_MAP_STYLE_URL` | ✅ | Licensed basemap style URL |
| `MAP_TILE_ORIGINS` | ✅ | Space-separated origins added to CSP `img-src`/`connect-src` |
| `NEXT_PUBLIC_DEFAULT_VIEW` | — | `lng,lat,zoom` initial map view |
| `UPLOADS_DIR` | — | Local photo storage directory (dev only; production needs managed object storage) |
| `REQUIRE_MFA_FOR_PRIVILEGED` | — | Forced `true` in production |
| `AUTH_PROVIDER` | ✅ | Must point to the managed provider; the dev adapter refuses to run in production |

Secrets live in the platform secret manager, never in the repo (`.env*` is git-ignored).

## Database roles (production) — **UNTESTED**
```sql
-- run once as the cluster admin
CREATE ROLE ics_owner LOGIN PASSWORD '<from secret manager>';            -- runs migrations, owns tables
CREATE ROLE ics_web LOGIN PASSWORD '<from secret manager>' NOBYPASSRLS;   -- app connections
-- after migrations create ics_anon / ics_app:
GRANT ics_anon, ics_app TO ics_web;
```
`ics_web` additionally needs DML on auth/session/notification/audit tables for the `system` context — grant explicitly per table; never grant ownership or `BYPASSRLS`.

## Deploy — **UNTESTED**
1. CI: `npm ci && npm run check && npm run build`; also run tests against a PostGIS container (ADR-0004).
2. Run migrations as `ics_owner` (`DATABASE_URL=<owner url> npm run db:migrate`). Migrations are forward-only; write expand/contract migrations so the previous app version keeps working.
3. Roll out the new container image gradually; health check `/` and `/api/map/resources?w=-83&s=35&e=-82&n=36`.

## Rollback — **UNTESTED**
Roll back the container image to the previous tag. Because migrations are expand/contract, the previous image works against the new schema. Never roll back a migration that dropped data; restore instead.

## Backup & restore — **UNTESTED**
Managed PITR with ≥ 14-day retention plus a daily logical dump to a separate account. Quarterly drill: restore to a new instance, run `npm test` against it with `DATABASE_URL`, compare row counts of `staging_sites`, `resources`, `resource_update_events`, `audit_logs`, record timings (RTO/RPO targets 4 h / 15 min in SOP-014).

## Known production blockers
Managed auth + MFA (M1) · licensed tiles (M2) · email provider + worker (M4) · shared rate limiter · nonce-based CSP · tests on real PostGIS · load tests over HTTP · legal copy (M8). See `docs/01-assumptions-risks.md`.
