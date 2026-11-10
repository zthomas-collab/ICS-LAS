# Systems Audit — Public Help-Finding & Nonprofit Onboarding

Date: 2026-11-10 · Build: `0123dee` (main) · Environment: local development (Next.js dev server, PGlite PostgreSQL 18 + PostGIS 3.6, synthetic data)

**Question audited:** Is the platform ready for (1) members of the public to find help and resources, and (2) nonprofits to apply and get approved?

> **Update — Week 1 fixes done (same day):** B2 map library upgraded (0 vulnerabilities), B3 applicant dead-end and duplicate applications fixed, P1 ZIP-aware map search, P2 Census ZIP data loaded (33,791 ZIPs), P5/P6 accessibility fixed (axe: 0 violations on map, Contacts and registration). Status column added below. Remaining blockers need external accounts: B1 email, B4 auth.

**Verdict:** The core flows work end to end and the data-protection model is strong. It is **not ready for real users yet**. There are 3 launch blockers (no real email, a critical map-library vulnerability, and an applicant dead-end) and a short list of high-impact usability gaps — chiefly that nonprofits must type GPS coordinates to add a location.

## How this was checked

| Check | Method | Result |
|---|---|---|
| Automated tests | `npm run check` (lint, typecheck, Vitest on real PostGIS) | 71/71 pass |
| End-to-end flows | Browser: register → confirm → admin approve (type required) → publish site → photo → public map/Contacts | All pass |
| Accessibility | axe-core 4 (WCAG 2.0/2.1/2.2 A+AA + best practice) on `/`, `/contacts`, `/signin`, `/signin?tab=register`, `/safety` | 2 issue types (below) |
| Mobile | 375 px viewport on every public and org page | No horizontal scroll |
| No-JavaScript | Server HTML of `/` and `/contacts` | Map/list need JS; Contacts works without JS |
| Dependencies | `npm audit --omit=dev` | **1 critical** (maplibre-gl) |
| Page weight | Production build, client chunks | Map library 266 KB gzip; all client JS 459 KB gzip |
| Server time | Warm local requests | 45–125 ms per page/API (dev mode, local, not a production SLO) |
| Discoverability | `/robots.txt`, `/sitemap.xml`, manifest icons | robots/sitemap 404; manifest has no icons |
| Onboarding code paths | Source inspection | Gaps listed below |

Not covered: real-network performance (3G throttling), screen-reader manual testing, load testing on production PostGIS, penetration testing, and seeing the map draw (the browser pane was hidden, which pauses map rendering; map data was verified).

## Launch blockers (P0)

| # | Finding | Affects | Evidence | Fix |
|---|---|---|---|---|
| B1 | **No email delivery.** Confirmation and sign-in links are only queued in `notification_jobs`; nothing sends them. Applicants cannot confirm, and nobody can sign in. | Nonprofits | No worker or provider configured (missing input M4) | Pick a provider (Postmark/SES/Resend), verify sending domain, add the job worker with retries |
| B2 | ✅ **Fixed.** Critical XSS advisory in maplibre-gl ≤ 6.4.0 (GHSA-jrc7-96c5-q579). Upgraded to 6.17.0; its worker is served from our origin (`scripts/copy-vendor.mjs`). `npm audit --omit=dev`: 0 vulnerabilities. Map visual rendering still to be eyeballed with the browser visible. | Public | `npm audit` | — |
| B3 | ✅ **Fixed.** Requesting sign-in with an unconfirmed email now re-sends the confirmation link (older links invalidated); re-submitting the same organization name reuses the open application. Tests in `onboarding.test.ts`. Was: **Applicant dead-end:** if the 24-hour confirmation link expires or is lost there is no "resend", and sign-in silently refuses unconfirmed emails. Registering again creates a duplicate organization. | Nonprofits | `requestSignIn` requires `email_verified_at`; no resend function | Add "Resend confirmation" on the sign-in tab (same no-enumeration message); block duplicate pending orgs per email |
| B4 | **Development sign-in in place** — no MFA for admins, single-instance rate limits. | Both | ADR-0005; refuses to run in production | Managed auth with MFA (missing input M1) |

## Public: finding help

**What works:** no account needed; map + list with clustering; category, type-legend and "confirmed only" filters; **Unconfirmed** shown instead of stale "Available"; call/directions buttons; restricted sites and contacts never reach the public (tested at the database level); Contacts search by name, description, type and ZIP + radius; 911/211 guidance on every page; mobile layout.

| # | Priority | Finding | Fix |
|---|---|---|---|
| P1 | ✅ Fixed | Map search now resolves a 5-digit ZIP to its center and moves the map there (private-only ZIPs never resolve). Was: **Map search doesn't understand ZIP codes as places.** Typing a ZIP only finds sites whose address has that exact ZIP; it doesn't center the map there. Contacts does support ZIP + radius. | Reuse the ZIP-centroid lookup on the map search; load the Census ZIP file (`npm run zips:import`) |
| P2 | ✅ Fixed (local) | Census 2024 ZCTA gazetteer imported (33,791 ZIPs); production must run the same `npm run zips:import`. Was: **ZIP reference data not loaded**, so Contacts distances are *estimated* from listed sites (the page says so). | Download the public-domain Census ZCTA gazetteer (~1 MB) and import |
| P3 | High | **Home page needs JavaScript and the 266 KB map library**. On slow phones or poor signal, people see nothing until it loads. | Server-render the list on `/` (map loads after); add a "Text-only list" link; measure on throttled 3G |
| P4 | Medium | **Not discoverable by search engines:** no `robots.txt`, no `sitemap.xml`, no social preview, manifest has no icons (cannot be installed as an app). | Add robots/sitemap for public pages, Open Graph image, PWA icons |
| P5 | ✅ Fixed | Food → #bf360c (5.60:1), Volunteer → #33691e (6.56:1); database CHECK now rejects any type colour under 4.5:1. Was: **Colour contrast:** Food (#d84315, 4.44:1) and Volunteer (#558b2f, 4.10:1) badges fall below 4.5:1 for small white text. | Darken to e.g. #bf360c and #33691e |
| P6 | ✅ Fixed | Emergency banner is now an `<aside aria-label="Emergency information">`. | — |
| P7 | Medium | English only. | Spanish translation of public pages first |
| P8 | Medium | **Empty map at launch.** Public value depends entirely on onboarded organizations. | Pre-launch onboarding drive (see nonprofit section); show Contacts and 211 prominently when the map is empty |
| P9 | Low | No offline shell (PWA service worker) though the PRD calls for one. | Add after B1–B3 |

## Nonprofits: applying and getting approved

**What works:** one "For organizations" page with Sign in / Register tabs; clear 3-step explanation; 7 required fields (28 controls total, most optional); type requested by applicant and confirmed by admin (required, enforced in the database); dashboard shows status; admin queue shows evidence, requested type and a 48-hour SOP due date; approval/rejection/suspension all audited; approved orgs publish immediately.

| # | Priority | Finding | Fix |
|---|---|---|---|
| N1 | High | **Adding a location requires typing latitude/longitude** (or standing at the site and tapping "Use my current location"). Most staff don't know coordinates. | Address search (geocoder) and/or "tap the map to drop a pin" on the site form |
| N2 | High | **Admins aren't notified** of new applications; the 48-hour target depends on someone checking the queue. | Email/SMS admins on new submissions; show overdue count in the header; daily digest |
| N3 | High | **One person per organization:** no staff invitations, so a nonprofit can't add volunteers or a backup. | Team & Permissions page: invite by email, roles, revoke (SOP-013) |
| N4 | Medium | **Rejections give no actionable reason** (generic email). Applicants can't fix and resubmit. | Add an optional "message to applicant" on reject; allow resubmission |
| N5 | Medium | No "what to have ready" checklist before registering (EIN/501(c)(3), state registration). Admin evidence standard is undefined (missing input M9). | Publish the checklist on the Register tab; finalize SOP-001 evidence rules |
| N6 | Medium | Registration limited to 5 attempts per 15 minutes per IP — a shelter or office sharing one connection could be blocked during an onboarding event. | Raise the limit or key by email + IP; use a shared limiter |
| N7 | Low | Long form on one screen (28 controls including 14 service checkboxes). | Collapse "other services" behind a toggle; save draft |
| N8 | Low | No admin UI to grant roles (responders, other admins) — CLI only. | Admin role management page |

## Platform & operations

| # | Priority | Finding | Fix |
|---|---|---|---|
| O1 | High | No CI: tests aren't run automatically on push. | GitHub Actions: lint, typecheck, tests (+ real PostGIS service container) |
| O2 | High | Photos stored on local disk, not virus-scanned (dev-only store refuses production). | Managed private object storage + AV scan (M5) |
| O3 | High | No backups/restore drill, no monitoring/alerting, no production database yet. | Managed PostgreSQL + PostGIS with PITR; uptime + error alerts; quarterly restore test |
| O4 | Medium | Signed-in map queries over a large area measured 563 ms p95 at 10,000 sites (dev), above the 500 ms target. | Set-based visibility check |
| O5 | Medium | CSP still allows inline scripts. | Nonce-based CSP |

## Recommended order

1. ✅ **Week 1 — done:** B2 map-library upgrade · B3 resend confirmation + duplicate guard · P5/P6 accessibility fixes · load ZIP data (P2) and ZIP-aware map search (P1). *(All doable now without external accounts.)*
2. **Needs your accounts/decisions:** B1 email provider · B4 auth provider · O2 storage · O3 hosting/database · map tile provider.
3. **Before an onboarding drive:** N1 pin-drop/address entry · N2 admin alerts · N3 staff invites · N4 rejection messages · N5 checklist.
4. **Before public launch:** P3 server-rendered list · P4 discoverability · O1 CI · P7 Spanish.
