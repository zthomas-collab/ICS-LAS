# B. Assumptions, Missing Inputs and Top Risks

## Assumptions (explicit — revisit if wrong)

1. Initial operating area is the United States; addresses, ZIPs and counties follow US conventions. Coordinates are WGS 84 (SRID 4326).
2. English-only UI for MVP; copy is structured for later i18n (Spanish is the most likely second language).
3. A single platform tenant run by Hiraeth Ventures; organizations are data-level tenants, not separate deployments.
4. Platform administrators perform organization verification manually against documents (EIN/IRS determination, state registration, references). No automated KYC vendor in MVP.
5. "Active operations" mode is a per-region flag set by a platform admin; it tightens freshness intervals (e.g. shelter 2 h).
6. Quantities are reported by organizations and are not an inventory ledger.
7. Public visitors never need an account. Their location is only used client-side and as a map viewport.
8. Hosting will be a container platform with managed PostgreSQL 16+ and PostGIS 3.4+.

## Missing inputs (blocking production, not blocking the dev slice)

| # | Missing input | Current stand-in | Needed by |
|---|---|---|---|
| M1 | Managed authentication provider choice + credentials (with MFA/WebAuthn) | Dev-only email magic-link adapter behind `AuthProvider` interface, clearly labelled | Phase 7 (before any real user) |
| M2 | Licensed map tile provider + key (e.g. MapTiler, Stadia, Protomaps self-hosted) | `NEXT_PUBLIC_MAP_STYLE_URL`; defaults to MapLibre demo tiles (low detail, labelled "not for production") | Phase 2 launch |
| M3 | Geocoding provider + terms allowing storage | Search matches stored city/ZIP/county/address text only | Phase 2 launch |
| M4 | Transactional email provider (SES/Postmark/Resend) + verified sending domain | `notification_jobs` rows + dev outbox page; no email leaves the machine | Phase 1 launch |
| M5 | Private object storage + malware scanning service | Site photos stored on local disk (`.data/uploads`, dev only; refuses to run in production) and re-encoded, but **not virus-scanned** | Before photos are enabled in production |
| M6 | Production PostgreSQL/PostGIS instance, backups, PITR | PGlite (PostgreSQL 18 + PostGIS 3.6 in WASM) for local dev/tests; `DATABASE_URL` switches to real Postgres | Phase 7 |
| M7 | Approved government/agency road feeds (state DOT 511, NWS) and their terms | None — `official_status` can only be set manually by authorized verifier | Phase 5 |
| M8 | Legal review: terms of use, privacy policy, contact consent language, liability disclaimer | Placeholder safety page copy | Before public launch |
| M9 | Organization verification evidence checklist (what documents count) | SOP-001 draft in `docs/sop/` | Phase 1 launch |
| M10 | Geographic scope definitions for authorized responders (counties? polygons?) | Polygon `scope_area` on `role_assignments` | Phase 2 |

## Top risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Restricted site coordinates leak via API, cache, export, search suggestion or error message | Operational security / safety harm | Public read model views with whitelisted columns; RLS on base tables under a non-superuser DB role; authorization tests for every boundary; no CDN caching of authenticated responses |
| R2 | Stale "Available" shown as fact during a disaster | People travel to empty sites | Freshness computed in the read model, not the UI; expired → "Unconfirmed"; filter for confirmed only |
| R3 | Community road report treated as official closure | Unsafe routing decisions, liability | Separate `official_status`; only verifier role with source reference may set; UI labels; no navigation integration |
| R4 | Fraudulent organization gets approved and publishes misleading resources | Public harm | Human verification SOP-001, suspension switch (SOP-012) that unpublishes immediately, complaint path (SOP-011), audit |
| R5 | Compromised org account | Data tampering | MFA for privileged roles (blocked on M1), session revocation table, access revocation SOP-013, append-only history to restore |
| R6 | Anonymous scraping of directory/contacts | Harassment of contacts | Restricted fields never in public payloads; rate limiting; result caps; no bulk export for anonymous |
| R7 | Surge traffic during an event | Outage when most needed | Cacheable public endpoint (short TTL + invalidation), bbox caps, list view, horizontal scaling; load tests in Phase 7 |
| R8 | PGlite PostGIS extension is experimental | Dev/prod behaviour drift | Production uses real PostGIS; CI should also run the suite against a real PostGIS container (add when Docker available) |
| R9 | Dev auth adapter accidentally deployed | Account takeover | Adapter refuses to start when `NODE_ENV=production` unless `ALLOW_DEV_AUTH=never-in-prod` is unset — i.e. it throws; documented in runbook |
| R10 | Scope creep toward case management/CRM | Mission drift, privacy risk | PRD §2; no tables for beneficiaries or requests |
