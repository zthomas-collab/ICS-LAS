# Architecture Decision Records

Format: Context → Decision → Consequences. Status is **Accepted** unless noted.

## ADR-0001 Modular monolith on Next.js + TypeScript
**Context.** Small team, one product, strong consistency needs between authorization and data. **Decision.** One Next.js (App Router, Node runtime) deployable; domain code in `src/server/modules/*` behind typed functions; UI and route handlers are thin. **Consequences.** Simple deploys and transactions; modules must not import each other's SQL; a module can be extracted later if load demands it (no evidence yet).

## ADR-0002 Authorization enforced in PostgreSQL, not only the app
**Context.** Leaking a restricted staging site is the most severe failure. UI and service checks alone are one bug away from a leak. **Decision.** Request roles `ics_anon` (views only) and `ics_app` (RLS) plus whitelisted public read-model views, column privileges for private org fields, and triggers for visibility invariants. Services still check first for good error messages. **Consequences.** Raw-SQL mistakes in request code cannot bypass visibility; RLS functions must stay fast (see perf finding in `05-milestones-acceptance.md`).

## ADR-0003 Three execution contexts
**Decision.** Every query runs in `anon`, `viewer(userId)` or `system`. `system` is reserved for auth, registration, admin decisions after an in-transaction role check, and jobs. **Consequences.** Code review rule: any new `system` usage needs a justification comment.

## ADR-0004 PGlite for development and tests
**Context.** No Docker/PostgreSQL on the build machine; tests must hit real PostGIS semantics. **Decision.** Use `@electric-sql/pglite` + `@electric-sql/pglite-postgis` (PostgreSQL 18, PostGIS 3.6 in WASM) when `DATABASE_URL` is unset; production requires `DATABASE_URL`. **Consequences.** Fast hermetic tests. PGlite's PostGIS build is labelled experimental and PGlite runs as superuser (RLS tests use `SET ROLE`), so CI must also run the suite against a real PostGIS container before release (Phase 7). Single-process: stop the dev server before CLI scripts.

## ADR-0005 Dev authentication adapter (temporary)
**Context.** Managed auth provider not chosen (missing input M1). **Decision.** Email magic links with hashed single-use tokens and server-side sessions, behind `identity.ts`; refuses to run in production. **Consequences.** No MFA yet — privileged roles must not be used with real data until replaced. Sessions table remains useful for revocation with a managed provider.

## ADR-0006 Planar viewport filtering
**Context.** A test showed `geography && envelope` returns points outside a lat/lng viewport (geodesic bounding boxes). **Decision.** Viewport queries use `location::geometry && ST_MakeEnvelope(...)` on a functional GiST index; distance/coverage checks (responder scope) keep `geography` semantics. **Consequences.** Exact viewport results; antimeridian-crossing viewports are rejected (w < e) — acceptable for US operations.

## ADR-0007 Basemap provider (Proposed)
**Decision.** `NEXT_PUBLIC_MAP_STYLE_URL` configures the style; dev default is OpenFreeMap (free, OSM-based, no key, no SLA). Production must select a licensed provider with an SLA (MapTiler, Stadia, or self-hosted Protomaps) and update `MAP_TILE_ORIGINS` for CSP.
