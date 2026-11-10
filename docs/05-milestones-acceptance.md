# F. MVP Milestone Plan and Acceptance Tests

## Milestones

| Phase | Scope | Exit criteria | Status |
|---|---|---|---|
| 0 | PRD, assumptions/risks, threat model, access matrix, data classification, ADRs | Docs reviewed by Hiraeth | ✅ drafted (this folder) |
| 1 | Auth adapter, org registration/confirmation/verification, foundational schema + RLS | Onboarding tests green; admin can approve | ✅ slice done (dev auth only) |
| 2 | Staging sites, publishing, public map + list, visibility enforcement | Authorization matrix tests green; mobile layout | ✅ slice done |
| 3 | Availability, freshness, audit workflows; freshness dashboard; reminder jobs | Expired never shows Available; SOP-005 reminders sent by worker | 🟡 freshness + events done; worker/dashboards pending |
| 4 | Directory + Black Book (public/restricted), staff invites, org profile | Restricted contacts absent from every public payload (tests) | ⏳ schema only |
| 5 | Road reports: submit, review, duplicate/supersede, official status from authorized source; private photo storage + AV scan | Lifecycle + official-status tests | ⏳ schema only |
| 6 | SOP dashboards, notifications worker + email provider, monitoring, admin audit UI | Dashboards read real events only | ⏳ |
| 7 | Managed auth + MFA, nonce CSP, shared rate limiting, load tests on real PostGIS, deployment, rollback, backup/restore drill | Measured SLOs, restore test report | ⏳ |

## Acceptance criteria → evidence

| # | Criterion | Evidence (automated unless noted) | Status |
|---|---|---|---|
| 1 | Anonymous search without sign-in | `visibility.test.ts › anonymous visitors see only PUBLIC sites`; `onboarding.test.ts › approved org publishes…`; browser check of `/` unauthenticated | ✅ |
| 2 | Verified nonprofit publishes and immediately updates own site | `visibility.test.ts › a verified org editor publishes and updates immediately`; browser E2E (register→approve→create→update) | ✅ |
| 3 | Org cannot change another org's resources | `› another org cannot edit, archive or add resources…`, `› raw UPDATE … affects zero rows under RLS`, `› cannot move a site to another organization` | ✅ |
| 4 | Restricted location never returned by anonymous APIs | `› anonymous visitors see only PUBLIC`, `› anonymous DB role cannot read base tables`, `› search suggestions respect visibility`, payload string checks | ✅ |
| 5 | Expired resource does not display confirmed availability | `freshness-spatial.test.ts › … become EXPIRED and drop out of confirmed-only filters`; `domain.test.ts › never shows Available when expired` | ✅ |
| 6 | Road observation never becomes official closure without agency authority | DB CHECK constraint on `road_incidents` (official status requires source ref + verifier) — **tests ship with Phase 5** | 🟡 |
| 7 | Users view permitted Black Book contacts and initiate contact | Public Black Book live with Call/Email/Website (`blackbook-types-images.test.ts`, browser check); restricted contacts for authorized users ship in Phase 4 | 🟡 |
| 8 | Restricted contact details never in public payloads | `› exposes only public channels — never the private contact email`; org `contact_email` not granted to request roles | ✅ for org accounts; Phase 4 for `directory_contacts` |
| 9 | All material changes timestamped and auditable | `› availability updates are append-only events…` (DELETE rejected), audit rows for site/org actions | ✅ |
| 10 | Functional on mobile viewports and degraded networks | Manual: 375 px no horizontal overflow on `/`, `/register`, site page; stale-data banner logic. Automated a11y/perf runs pending (Phase 7) | 🟡 |
| 11 | Every visible UI action has real behavior | Unbuilt modules are not linked in navigation | ✅ (manual review) |
| 12 | Demo data labelled synthetic | `is_synthetic` columns; `[SYNTHETIC]` names; **SYNTHETIC DEMO** badges in UI | ✅ |

## Test inventory (76 tests, all passing at time of writing)

- `tests/contacts-types-images.test.ts` — Contacts consent/visibility/no private fields, filters, ORG_ADMIN-only edits; approved-needs-type constraint, legend data on pins, admin-only type change; image sniffing, EXIF/GPS stripping + orientation, photo visibility per site rule, cross-org upload blocked, replace/remove history, suspension hides photos; Contacts text/type/ZIP/radius search, nearest-first ordering, office-ZIP orgs, centroid fallback, private sites never used for location matching.

- `tests/migrations.test.ts` — migrations apply on PostgreSQL 18 + PostGIS 3.6 and are idempotent.
- `tests/visibility.test.ts` — full visibility matrix, RLS raw-SQL bypass attempts, revoked access, suspension, resource vs site visibility, history immutability.
- `tests/onboarding.test.ts` — registration validation, single-use/expiring tokens, SOP-001 open/complete, self-approval blocked, suspend/reinstate, session revocation.
- `tests/freshness-spatial.test.ts` — interval expiry, active-ops tightening, DUE_SOON, reconfirmation; bbox edge correctness, precision, invalid boxes, truncation, GiST index usage.
- `tests/domain.test.ts` — display rules, visibility ordering, contact link helpers.

## Performance measurement (development indication only — NOT an SLO claim)

`npm run bench:viewport`, 2026-11-10. Conditions: PGlite (PostgreSQL 18 + PostGIS 3.6, WASM, single process, in-memory) on Intel i7-13620H / 16 cores / 17 GB, Node 24.20; service layer only (no HTTP, no network, no concurrency); 10,000 sites (½ public), 19,979 resources across 3°×3°; 200 random viewports per row.

| Viewport | Caller | Avg sites returned | p50 | p95 |
|---|---|---|---|---|
| City 0.25° | anonymous | 34 | 10.7 ms | 16.7 ms |
| City 0.25° | authenticated | 47 | 37.6 ms | 55.5 ms |
| Region 1.5° | anonymous | 500 (capped) | 93.9 ms | 120.0 ms |
| Region 1.5° | authenticated | 500 (capped) | 466.5 ms | **562.9 ms** |

Finding: authenticated region-scale queries exceed the 500 ms p95 objective because `can_view_site` is evaluated per candidate row in PL/pgSQL. Remediation (Phase 3/7): set-based visibility predicate in `visible_site_ids_in_bbox`, plus server-side clustering at low zoom. Production numbers must be re-measured on managed PostGIS under concurrent HTTP load (k6) before any SLO is claimed.
