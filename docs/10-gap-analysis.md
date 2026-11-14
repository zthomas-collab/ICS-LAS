# 10. Crisis Compass Carolinas: Phase 0 repository audit and gap analysis

Audited 2026-11-14 against branch `crisis-compass-phase-1` (HEAD `deab36d`, PR #2). Method: read docs 00-09, all migrations (0001-0010), every page, route and server action under `src/app`, every server module, and the test suite; ran typecheck, lint and the full test suite (170 tests pass, 1 lint warning). Status uses "verified" only where a UI, authorization, persistence and test were all found. A table or service function alone is **not** counted as complete.

Legend: **Done** = UI + API + data + authorization + tests. **Backend only** = service/schema/tests exist, no UI (cannot be used by a person). **Partial** = some parts exist. **Missing** = nothing found.

## 1. Key finding: the README overstates Phase 2

`docs/09` and the commit log describe Phase 2 (assistance applications) as built. What exists is the **database and service layer only**:

* Migration `0010_assistance.sql`: categories, user profiles, routing rules, applications, append-only events, documents, transition guard trigger, RLS policies.
* `src/server/modules/assistance.ts` (676 lines): submit, track, withdraw, respond to info requests, staff list/detail/transition/note, document upload/read/remove, routing-rule admin, and a production readiness gate. 33 tests cover it against real PostGIS.
* **No page or form imports it** (`grep modules/assistance src/app src/components` returns nothing). There is no `/assistance`, `/dashboard/applications` or `/admin/applications`. `registerPublicAccount` (identity.ts) is also not wired to any page; `/register` registers *organizations* only.

So a resident cannot currently register, apply, upload or track anything, and staff cannot review anything, in the running app.

## 2. Feature matrix (directive section → actual state)

| # | Directive item | State | Evidence / what is missing |
|---|---|---|---|
| 1 | Executive dashboard | **Partial** | `/admin`, `/admin/counties`, `/admin/organizations`, `/admin/profiles` exist (counties, county-admin assignment, org verification/suspension, profile approval). Missing: metrics dashboard, events, projects, intake, settings UI, reports. No hard-coded stats exist because no stats exist. |
| 1 | Events + logistics (calendar, task board, table) | **Missing** | No `events`, `event_tasks` tables or pages. |
| 2 | Org profiles, logo, website, socials, counties served, approval | **Done** | Phase 1; tests in `crisis-compass-foundation.test.ts`. Missing vs directive: operating hours on profile, upcoming events, educational materials on profile, ZIPs served (only counties). |
| 2 | Public directory (search/filter/profile) | **Done / Partial** | `/contacts` searches name, type, ZIP+radius; `/orgs/[id]` profile. Missing: county filter, resource-category filter, publicly listed resources on the profile. |
| 3 | Branding | **Done (this session)** | Official logo, tokens, fonts, header. Open: no favicon/manifest icon from the official mark (needs a small-size original); no browser visual QA yet; executive/county dashboards not distinct. |
| 4 | Public accounts | **Backend only** | `registerPublicAccount`, `user_profiles`; no sign-up page, no profile edit page. |
| 4 | Assistance application pipeline | **Backend only** | See section 1. State machine, history, routing, doc intake, withdraw/respond all in service + DB. No forms, tracker, staff queue, or applicant-visible notifications UI. |
| 4 | Routing by county/ZIP/category | **Partial** | `application_routing_rules` + `findRoute` exist. **No ZIP→county crosswalk**: `zip_codes` holds centroids only, so ZIP→county, multi-county ZIP disambiguation, and "ZIP not in county" validation are not possible yet. |
| 4 | Org referral without data leakage | **Backend only** | RLS `can_view_application_row` restricts to referred org and consent flag; tested. No org UI to accept/decline. |
| 4 | Production security gate | **Partial** | Gate (`assistanceReadiness`) is real and fail-closed. Built: magic-link + TOTP MFA, SMTP worker with retry/dead-letter, S3 store, ClamAV, rate limiter. **Not done / unverified**: no retention/purge job, no privacy notice or consent text approved by counsel, no legal review, backup/restore is documented as **UNTESTED**, `unsafe-inline` CSP, rate limiter store is not shown to be shared across instances, no anti-spam beyond rate limits, no security monitoring/alerting. |
| 5 | `/learn` video + resource library | **Missing** | No tables, pages, moderation, URL validation, or CSP `frame-src`. |
| 6 | Role hierarchy | **Partial** | Executive (`PLATFORM_ADMIN`), County Admin (scoped, RLS, tested, revocation kills sessions), Nonprofit (org membership) done. Public account backend only. **Volunteer/Donor role missing.** Multi-role works. |
| 7 | Volunteer & donation intake | **Missing** | No tables, form, reference numbers, intake dashboard, or email-to-configured-address. `platform_settings` exists (key/value) but has no UI and no email-destination setting. The notification queue (retry) exists and can be reused. |
| 8 | Community projects (ZIP needs, commitments, matching) | **Missing** | No project, need, commitment or delivery tables. Must model requested/offered/accepted/dispatched/received/verified quantities and prevent double-allocation. |
| 8 | Matching engine | **Missing** | Reusable: `zip_codes` PostGIS radius search, org service areas, service types. |
| 9 | Public map | **Done (existing)** | MapLibre + PostGIS, clustering, filters, ZIP/near-me, freshness, directions (now phone-native). Missing: projects layer, county filter, directory links from pins, nearby-org panel. Privacy: map reads `public_*` views only; no application data can reach it (verified by design and by visibility tests). |
| 10 | Dashboards/reports | **Missing** | No report queries or pages for any role. |
| 11 | Security controls | **Mostly built, partly unverified** | RLS (policies on 0001, 0004, 0008, 0010), audit logs, zod validation, rate limits, MFA, private storage, malware scan interface, email queue are all present and tested. Gaps listed in the security-gate row. |
| 12 | Accessibility testing | **Partial** | Earlier axe run (0 violations) predates the brand change and Phase 2 pages; must be re-run. |

## 3. Production blockers (must close before real applicant data)

1. No UI exists, so nothing can be tested end to end by a human; build and run an end-to-end pass first.
2. Provision and test: managed SMTP/provider, S3 private bucket, ClamAV, `AUTH_PROVIDER=magic-link-mfa`, `MFA_ENCRYPTION_KEY`, shared rate-limit store.
3. Retention/deletion policy implemented as a scheduled job with tests, plus applicant data export/deletion handling.
4. Counsel-approved privacy notice, consent wording and data-sharing terms; the founding "no beneficiary data" rule in `03-access-matrix.md` and the threat model must be formally superseded by an ADR.
5. Backup restore drill actually performed and timed.
6. Nonce-based CSP, security monitoring/alerting, dependency and secret scanning in CI.
7. ZIP→county crosswalk loaded (Census/HUD relationship file) so routing and project scoping are correct.

## 4. Proposed build order (additive migrations from 0011)

| Stage | Deliverable | Migration | Reuses |
|---|---|---|---|
| 2a | Resident sign-up, profile, apply, track, respond, withdraw UI; staff queue and detail with transitions and notes; org accept/decline referral UI; routing-rule admin UI; applicant status emails | none (0010) | `assistance.ts`, notification queue, MFA |
| 2b | ZIP↔county crosswalk import + disambiguation in forms and routing | 0011 `zip_county` | `zip_codes`, `zips:import` |
| 4a | Volunteer/donation offers: form, reference numbers, executive intake, status flow, configurable destination email in settings, queued email | 0012 `contribution_offers`, `volunteer_profiles`, settings keys | `platform_settings`, notifications |
| 4b | Community projects: needs, quantities (requested/offered/accepted/dispatched/received/verified), commitments, delivery confirmation, match suggestions (suggest only, never auto-commit), public generalized view | 0013 | PostGIS, service areas |
| 5 | Events, tasks, assignments, calendar/board/table | 0014 | counties, orgs |
| 5 | Executive, county, nonprofit dashboards from real queries | views only | everything above |
| 6 | `/learn` library with moderation, URL allow-list, CSP `frame-src` | 0015 | org profiles |
| 6 | Accessibility, performance, security, rollback validation | none | |

Each stage ships with: authorization and county-isolation tests, audit events, notification-failure and duplicate tests, resource-count accuracy tests, doc updates, and a stated list of operational limits.

## 5. Decisions needed from the owner

1. **Confirm the policy reversal** (collecting assistance applications) and who owns legal review. Without it, stage 2a can be built and demoed locally but must not be enabled in production (the readiness gate enforces this).
2. Email provider and the Crisis Compass destination address for offers.
3. Source for the ZIP→county crosswalk (HUD USPS crosswalk or Census relationship file) and the county list in scope (NC, SC, or both).
4. Approved video hosts for `/learn` (YouTube, Vimeo, others).
5. A small-size/icon version of the official logo for favicon and app icon.

## 6. Progress log

**2026-11-14, owner decisions received:** (1) the policy reversal is **not confirmed**, so assistance stays switched off in production (the readiness gate already refuses it) and everything built here is for local/staging use; (2) the Crisis Compass destination email for offers will be set later by the executive in administrator settings, never in source; (3) ZIP-to-county data is static and ships with the code until a maintainer re-runs `scripts/build-zip-county.mjs` and releases; (4) `/learn` accepts YouTube only; (5) official icon supplied.

Built since the audit (uncommitted until the owner approves):

| Item | State |
|---|---|
| App icon and manifest icons from the official compass mark (`public/brand/originals/ccc-icon.png` kept unmodified) | Done. Only 192 and 256 px provided; a 512 px original would be needed for installable-app polish. |
| Static ZIP-county crosswalk (Census 2020 ZCTA relationship file, NC + SC, 1,277 ZIPs, 487 span several counties), migration 0011, loader run by `migrate`, FIPS back-fill on counties, ZIP/county validation in `submitApplication` | Done + 7 tests. Unknown ZIPs and counties without FIPS are not rejected (the data does not cover them). Multi-county disambiguation is enforced by requiring the person to choose a county and rejecting a ZIP outside it; there is no automatic county suggestion yet. |
| Resident sign-up `/signup`, request list `/assistance`, form `/assistance/new`, tracker `/assistance/[id]` (reply to info requests, withdraw, upload/remove documents), staff queue `/admin/applications`, staff detail `/admin/applications/[id]` (status moves, notes), document download route | Built on the existing, tested service layer. **Not yet exercised in a browser**, no UI-level automated tests, and still gated off in production. Provider (nonprofit) accept/decline UI and routing-rule admin UI are not built. |

Still open: executive settings page (destination email), volunteer/donation intake, community projects and matching, events, dashboards, `/learn`, retention job, browser/accessibility pass.
