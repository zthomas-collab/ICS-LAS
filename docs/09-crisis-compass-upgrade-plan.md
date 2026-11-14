# 09. Crisis Compass upgrade: audit, plan and Phase 1 status

Upgrade of the existing ICS-LAS application (formerly "HopeGrid") into **Crisis Compass**, a centralized emergency management, nonprofit resource coordination, community assistance and volunteer platform. This is an upgrade, not a rebuild: migrations are additive and every existing feature keeps working.

## 1. Current technology stack (audited)

| Layer | Finding |
|---|---|
| App | Next.js 16 (App Router, server actions, `dynamic = "force-dynamic"` pages), React 19, TypeScript, Tailwind 4 |
| Data | PostgreSQL + PostGIS in production (`pg`); PGlite (in-process PostGIS) for dev and tests. SQL migrations in `db/migrations`, applied in order, each in a transaction, recorded in `schema_migrations` |
| AuthN | **Development adapter**: email magic link + server-side sessions (hashed tokens, httpOnly cookie). Disabled in production unless explicitly acknowledged. No MFA yet (`mfa_enrolled_at` exists; `REQUIRE_MFA_FOR_PRIVILEGED` is forced on in production) |
| AuthZ | Three DB execution contexts (`anon`, `viewer`, `system`). `anon` reads only whitelisted `public_*` views. `viewer` runs as `ics_app` under row-level security. `system` is used only after an explicit server-side role check. Authorization functions live in the `ics` schema |
| Email | `notification_jobs` outbox. **No delivery worker or provider is configured**; dev outbox page at `/dev/outbox` |
| Files | Images only: sniffed, re-encoded to WebP, metadata stripped, stored through an `ObjectStore` interface (local filesystem in dev; production needs managed private storage) |
| Tests | Vitest against real PostGIS (PGlite): 80 tests before this upgrade, 103 after Phase 1 |

## 2. What exists vs. what the Crisis Compass brief needs

| Brief item | Status | Notes |
|---|---|---|
| Executive master account | **Partial** | `PLATFORM_ADMIN` already has platform-wide oversight, org approvals, audit. Missing: counties, events, reports, platform settings UI |
| Organization profiles + website links | **Done (Phase 1)** | Logo, website, social links, counties served, public/private (existing opt-in), administrator approval/hide |
| Crisis Compass branding + configurable theme | **Done (Phase 1)** | `src/config/brand.ts`; name, tagline, logo and colors via env; placeholder palette |
| Public accounts + assistance pipeline | **Not started** | See "Scope conflict" below. Phase 2 |
| Educational video library | **Not started** | Phase 4 |
| Role hierarchy | **Partial -> mostly done** | Executive = `PLATFORM_ADMIN`; County Administrator added (Phase 1); Nonprofit = approved org membership (existing); Public = signed-in user; Volunteer profile in Phase 3. Multiple roles per user already work |
| Volunteer / donation offers + email to Crisis Compass address | **Not started** | Phase 3. Needs an email provider and a settings table for the destination address |
| ZIP-based projects + resource matching | **Not started** | Phase 3. ZIP centroids (`zip_codes`) and radius search already exist and will be reused |
| Reporting dashboard | **Not started** | Phase 4 |
| Audit trail, RLS, validation, tests | **Reusable** | `audit_logs`, `writeAudit`, zod schemas, `runIn` contexts, fixtures |

## 3. Scope conflict that needs an explicit decision (before Phase 2)

The repository's founding documents state that the system **never collects requests for help or beneficiary data** ("Prohibited" row in `03-access-matrix.md`, "Not a CRM, case-management..." in the README, and the threat model). The brief reverses that: residents submit assistance applications with personal information and supporting documents.

This is a deliberate product change with real consequences, so it is **not** implemented silently:

* Applications contain disaster-survivor PII and possibly documents (IDs, damage photos, financial or medical context). A breach is materially more harmful than any data held today.
* Today's authentication is a development adapter, nothing is emailed, there is no MFA, no malware scanning and no managed object store. **Phase 2 must not go live on that foundation.**
* Needed first (blocking Phase 2 production use): managed authentication with MFA for staff roles, an email provider, private object storage with malware scanning, a retention/deletion policy and privacy notice, and a legal review of what may be collected and who may receive it.
* Proposed design (ready to build once the above is confirmed): separate `assistance_applications` tables; no public views at all; access only for the applicant, the routed county administrator, and an assigned provider organization; status transitions in a database function with an append-only history; documents in a private bucket served only through an authorization-checked route; all reads and status changes audited.
* When approved, `03-access-matrix.md` and the threat model will be updated and an ADR recorded.

## 4. Proposed role and permission matrix

| Capability | Public | Volunteer | Nonprofit member | County admin | Executive |
|---|---|---|---|---|---|
| Browse map, contacts, public profiles, videos | yes | yes | yes | yes | yes |
| Edit own organization profile and logo | | | ORG_ADMIN only | | yes (moderation) |
| Approve / hide an organization profile | | | | counties they administer, orgs serving them | all |
| Approve organizations (SOP-001), suspend | | | | | yes |
| Create counties, assign county administrators | | | | | yes |
| View the list of county administrators | | | | own counties | all |
| Submit assistance application (Phase 2) | own | own | own | n/a | n/a |
| Review applications (Phase 2) | | | assigned referrals only | own counties | all |
| Submit volunteer/donation offer (Phase 3) | yes | yes | yes | | |
| Manage projects and matches (Phase 3) | | | assigned projects | own counties | all |
| Reports (Phase 4) | | | own org | own counties | platform-wide |

Rules that are enforced and tested: authorization is re-derived from the database on every privileged call; a county administrator can never act outside assigned counties; expired or revoked assignments carry no access; revocation ends the person's sessions immediately; elevated roles require MFA wherever MFA enforcement is on (always in production).

## 5. Database changes

**Migration 0008 (applied in Phase 1, additive):** `counties` (seeded from counties already on staging sites), `county_admin_assignments`, `organization_counties`, helper functions `ics.viewer_county_ids()` and `ics.can_manage_county()`, and new `organizations` columns `logo_storage_key`, `logo_alt`, `logo_updated_at`, `social_links`, `profile_status`, `profile_reviewed_by/at`. `public_contacts` is recreated with the same columns plus logo, social links and counties served, and now requires `profile_status = 'APPROVED'`.

*Backward compatibility:* the migration backfills `profile_status = 'APPROVED'` for every approved or suspended organization that already had its public opt-in, so nothing disappears from Contacts on deploy. Existing rows are not deleted or rewritten otherwise. **Risk:** `public_contacts` is dropped and recreated inside the migration transaction; any external consumer of that view must be re-granted (the migration does so for `ics_anon` and `ics_app`).

**Planned:**

| Phase | Tables |
|---|---|
| 2 | `assistance_applications`, `assistance_application_events` (append-only), `assistance_documents`, `assistance_categories`, `application_routing_rules`, `notifications` |
| 3 | `volunteer_profiles`, `contribution_offers`, `platform_email_settings` (destination address kept in settings, never hard-coded), `community_projects`, `project_resource_needs`, `project_commitments`, `project_updates` |
| 4 | `events`, `event_tasks`, `event_assignments`, `video_resources`, `video_categories`; report queries and views |

## 6. Pages, routes and APIs

**Phase 1 (built):** `/admin` (landing), `/admin/counties`, `/admin/profiles`, `/orgs/[orgId]` (public profile), `/api/orgs/[orgId]/logo`, `/manifest.webmanifest` (now generated from brand config). Modified: `/dashboard/orgs/[orgId]/profile` (links, counties, logo), `/contacts` (links to profiles), root layout (brand, theme injection).

**Later:** Phase 2 `/assistance/*`, `/dashboard/applications`, `/admin/applications`. Phase 3 `/volunteer`, `/offers`, `/projects/*`, `/admin/projects`, `/admin/settings`. Phase 4 `/learn`, `/admin/events`, `/admin/reports`, `/admin/videos`.

## 7. Phases, dependencies and risks

| Phase | Scope | Depends on | Main risks |
|---|---|---|---|
| 1 Foundation (**done**) | Brand + theme, county admin role, org profiles, links | none | Placeholder brand colors; logo upload uses same-origin storage (CSP) |
| 2 Public assistance | Public accounts, applications, pipeline, routing, notifications, secure documents | **Decision in section 3**; managed auth + MFA, email provider, private storage + scanning | PII breach impact; legal and retention obligations; routing rules need real county/ZIP/category data |
| 3 Resource coordination | Volunteer/donation offers + email, projects, matching | Email provider; Phase 1 counties | Matching must only suggest, never commit; email destination configurable |
| 4 Engagement and reporting | Video library, events/logistics, reports | Phases 1-3 data | Video embeds need CSP `frame-src` allow-list and an approved-source list |

## 8. Inputs still needed from you

1. **Decision** on collecting assistance applications (section 3) and which of the blocking prerequisites are already underway.
2. **Branding:** official name usage, logo file (SVG preferred), final color values. Until then set `BRAND_*` variables or accept the placeholder palette.
3. **Authentication:** managed provider choice and MFA policy.
4. **Email:** provider (SES, Postmark, SendGrid...), sending domain, and the Crisis Compass destination address for contribution offers.
5. **Storage:** managed private object storage and malware scanning for documents.
6. **Routing data:** county list and which administrator or organization handles each assistance category per county/ZIP.
7. **Video policy:** which hosts are approved (YouTube, Vimeo, others).

## 9. Phase 1 configuration and deployment

1. Deploy and run `npm run db:migrate` (migration 0008 is additive; see backward-compatibility note above). Take a database backup first.
2. Optional branding (all validated; a malformed or low-contrast value is ignored with a logged warning):
   `BRAND_NAME`, `BRAND_TAGLINE`, `BRAND_OPERATOR`, `BRAND_LOGO_PATH` (a file under `/public`, e.g. `/brand/logo.svg`), `BRAND_COLOR_PRIMARY`, `BRAND_COLOR_INTERACTIVE`, `BRAND_COLOR_LINK`, `BRAND_COLOR_SOFT`, `BRAND_COLOR_ACCENT`, `BRAND_COLOR_BACKGROUND`, `BRAND_COLOR_TEXT` (each `#rrggbb`).
3. The first executive is created with `npm run admin:grant -- <email> PLATFORM_ADMIN "<reason>"`. The executive then adds counties and assigns county administrators at `/admin/counties`.
4. Executives and county administrators need MFA wherever enforcement is on (always in production), so managed auth must land before production use.
5. Organization administrators then pick the counties they serve and add links and a logo at `/dashboard/orgs/<id>/profile`; an administrator approves the profile at `/admin/profiles` (the first approval happens automatically when the organization itself is verified).
