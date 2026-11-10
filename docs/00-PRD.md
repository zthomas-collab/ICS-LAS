# A. Product Requirements Document — Hiraeth Ventures Resource Logistics & Response Platform (ICS-LAS)

Status: Draft v0.1 (Phase 0) · Owner: Hiraeth Ventures · Last updated: 2026-11-10

## 1. Purpose

A mobile-first, map-based platform that answers one question fast: **where is help, is it available, who runs it, how do I reach it, and when was that last confirmed?** Governing philosophy: **speed to resource**.

## 2. What this product is not

- Not a CRM, sales pipeline, investor lead tracker, or title-file pipeline.
- Not client case management. It never stores or displays individual requests for help or people needing help.
- Not an emergency dispatch system. It never claims to dispatch, and it never presents community observations as official closures.

## 3. Users

| Persona | Needs | Signs in? |
|---|---|---|
| Public visitor (survivor, neighbor, volunteer) | Find nearby food/water/shelter, see availability and freshness, call or get directions | No |
| Pending organization representative | Register an org, confirm email, wait for verification | Yes |
| Approved nonprofit / response org member | Publish and update sites and inventory in seconds from a phone | Yes |
| Organization administrator | Manage staff, roles, org profile, service areas | Yes |
| Authorized responder | See restricted logistics within their geographic + organizational scope | Yes (MFA) |
| Platform administrator | Verify orgs, moderate, control publication, review road reports | Yes (MFA) |
| Platform security administrator | Access revocation, audit review, incident response | Yes (MFA) |

**Account verification ≠ operational authority.** An approved org account lets members manage that org's own data. Seeing restricted responder logistics requires a separate, scoped `authorized_responder` role assignment.

## 4. Non-negotiable product decisions

1. Verified, authorized nonprofits/responders update their own staging locations and inventory immediately (no moderation queue in front of their own updates).
2. Only approved organizations create resource listings and submit road reports.
3. The Black Book holds both public and restricted contacts.
4. The map shows resources and road conditions only — never individual requests or people.
5. Public visitors browse public information without logging in.
6. No investor lead management, title pipeline or sales CRM.
7. An organization-submitted blockage is never treated as a government-confirmed closure without authorized verification.

## 5. Functional requirements by module

### Module A — Resource map
- A1 MapLibre GL JS map, licensed tile provider configured by environment (no hard-coded provider).
- A2 Server-side bounding-box queries over indexed `geography` columns; results capped and paginated.
- A3 Marker clustering; category and availability filters; "confirmed availability only" filter.
- A4 Accessible list view showing the same result set; list-first on low bandwidth.
- A5 Search by city, address, ZIP, county; "near me" only after explicit browser consent; location never sent to the server except as a viewport.
- A6 Safe directions links only for locations whose `location_disclosure` is public.
- A7 Each pin shows verification state, freshness state, owning org, and last-confirmed time.
- A8 Public pins never expose private staging sites, restricted inventory, beneficiary data, or responder logistics.

### Module B — Resource logistics
- B1 Org members with `editor`/`org_admin` roles create/edit/archive sites (no hard delete of published sites; archive preserves history).
- B2 Multiple resources per site; category, status (Available / Limited / Depleted / Temporarily Closed / Unknown), reported quantity + unit, expected availability, review deadline.
- B3 Four visibility levels: `PUBLIC`, `ORGANIZATION_NETWORK`, `AUTHORIZED_RESPONDERS`, `PRIVATE_ORGANIZATION`. A resource is never more visible than its site.
- B4 Append-only `resource_update_events` with actor, org, before/after, source (`reported` vs `verified_count`).
- B5 Quantities are *reported* values, not ledger transactions; verified physical counts are flagged separately.
- B6 Mobile one-tap status update ("Still available", "Limited", "Depleted").

### Module C — Organization system
- C1 Registration + email confirmation. C2 Human verification by platform admin (SOP-001). C3 Invitations, staff roles. C4 Profiles, service areas (geography polygons), categories, hours. C5 Approval/suspension states. C6 Stale-record reminders. C7 Verification and change audit.

### Module D — Road conditions
- Observation types, report fields and lifecycle `SUBMITTED → UNDER_REVIEW → ORGANIZATION_CONFIRMED → RESOLVED → ARCHIVED`. `official_status` tracked separately and set only by an authorized verifier citing an authoritative source. Duplicates/superseding supported. Photos private by default with EXIF stripped.

### Module E — Black Book
- Entries with public and restricted contact channels, credentials, consent/publication permissions, verification timestamps. Restricted channels never appear in public search suggestions, previews, exports, sitemaps or APIs.

### Module F — Admin & operations
- Dashboards computed from real event records only. SOP engine (definitions + executions). Freshness dashboard. Audit log viewer.

## 6. Freshness

Configurable per category in `freshness_policies` (initial: shelter 2h active-ops, food/water 4h, equipment 8h, road reports 2h, nonprofit program details 7d, directory contacts 90d). When exceeded, the read model reports `freshness = EXPIRED` and the public status becomes **"Unconfirmed — last confirmed <time>"**; the stored status and history are preserved. "Confirmed availability only" filter excludes expired records.

## 7. Non-functional requirements

| Area | Objective (must be measured before claiming) |
|---|---|
| Mobile first load | Usable < 3 s on throttled "Fast 3G"/mid-tier Android profile |
| Viewport query | p95 < 500 ms at ≥ 10,000 spatial records under defined load |
| Common API ops | p95 < 300 ms excluding external latency |
| Availability | 99.9 % monthly after stabilization |
| Accessibility | WCAG 2.2 AA on map controls, list view and forms |
| Degraded network | PWA shell, last-sync time visible, stale cache never shown as live |

## 8. Public safety requirements

Emergency guidance ("Call 911 for life-threatening emergencies") on every public page. Road observations labelled "Community-reported — not an official closure". No driving-safety assurances. Timestamps and source provenance on every record. Agency feeds only through approved, tested connectors.

## 9. Out of scope for MVP

Offline write/sync, routing/turn-by-turn navigation, beneficiary intake, donations/payments, SMS broadcast, native apps.
