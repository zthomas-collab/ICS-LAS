# E. User Journeys and Sitemap

## Journeys

### J1 — Public visitor finds water (no account) ✅ implemented
1. Opens `/` on a phone → map centered on the deployment's default area, list available via **List** toggle.
2. Searches "28801" or taps **Near me** (browser asks for consent; location stays on the device and only moves the map).
3. Filters: **Water**, **Only confirmed availability**.
4. Taps a pin or list card → sees operator, address, hours, status ("Available" / "Limited" / **"Unconfirmed — last reported Available"**), last-confirmed time, quantity basis.
5. Taps **Call** (tel: link) or **Directions** (offered only for public locations).
6. Offline/poor signal: banner "Couldn't refresh — showing data from 11:24 AM, availability may have changed"; list is dimmed; auto-retries when back online.

### J2 — Nonprofit onboarding ✅ implemented
1. `/register` → org details + verification notes → "check your email".
2. Email link → `/auth/confirm` → **Confirm email** button (POST, so link scanners can't consume it) → signed in → dashboard shows **PENDING VERIFICATION**; SOP-001 opened with 48 h due date.
3. Platform admin `/admin/organizations` → reviews evidence → **Approve** with evidence summary → org notified (queued email).
4. Rep returns, signs in via magic link → dashboard shows **New site**.

### J3 — Approved org publishes and updates a site from a phone ✅ implemented
1. **New site** → name, visibility (warning shown for Public), **Use my current location**, address fields → **Create site** → immediately on the public map if PUBLIC.
2. **Add a resource** → category, status, quantity + unit + basis, visibility (only equal or stricter than the site).
3. Later: one-tap **Still accurate** / **Limited** / **Depleted** buttons; **record correction** with note (SOP-004). Each writes an append-only event visible under **Recent changes**.
4. **Archive site** → removed from all maps immediately; history preserved.

### J4 — Authorized responder sees restricted logistics ✅ data path implemented (role grant via CLI/SQL for now)
Signed-in responder sees AUTHORIZED_RESPONDERS sites only within their scope polygon, labelled **Restricted — do not share**, with no directions link.

### J5 — Admin suspends a compromised org (SOP-012) ✅ implemented
`/admin/organizations` → **Suspend publication** with reason → all that org's listings disappear from public and network views at once; editing disabled; **Reinstate** reverses.

### Planned journeys
J6 road report submission/verification (Phase 5) · J7 Black Book lookup + click-to-call (Phase 4) · J8 stale-record reminder emails (Phase 6) · J9 public "report incorrect info" (Phase 6) · J10 staff invite/revoke (Phase 4).

## Sitemap

Legend: ✅ live in this slice · ⏳ planned (not linked in the UI until it works — acceptance criterion 11)

```
Public
├── /                         ✅ Home / Map + List + Search + Filters
├── /safety                   ✅ About / Safety / corrections guidance
├── /register                 ✅ Register organization
├── /signin                   ✅ Organization sign-in (dev magic link)
├── /auth/confirm             ✅ Email confirmation (POST)
├── /auth/callback            ✅ Sign-in link (POST)
├── /resources                ⏳ Find Resources (category landing pages)
├── /roads                    ⏳ Road Conditions
├── /directory                ⏳ Nonprofit Directory
└── /black-book               ⏳ Black Book (public entries)

Authenticated
├── /dashboard                ✅ Organization Dashboard + My Staging Locations
├── /dashboard/orgs/:id/sites/new  ✅ New staging site
├── /dashboard/sites/:id      ✅ Site detail: inventory, Update Availability, history
├── /dashboard/roads/new      ⏳ Submit Road Report
├── /dashboard/profile        ⏳ My Organization Profile
├── /dashboard/black-book     ⏳ Authorized Black Book
├── /dashboard/notifications  ⏳ Notifications
└── /dashboard/team           ⏳ Team & Permissions

Administrative
├── /admin/organizations      ✅ Organizations Awaiting Approval (+ suspend/reinstate)
├── /admin/moderation         ⏳ Resource Moderation
├── /admin/publication        ⏳ Map Publication Controls (active-ops toggle)
├── /admin/roads              ⏳ Road Report Review
├── /admin/black-book         ⏳ Black Book Verification
├── /admin/freshness          ⏳ Operational Freshness Dashboard
├── /admin/audit              ⏳ Audit Logs
└── /admin/sops               ⏳ SOP Configuration

API
├── GET /api/map/resources    ✅ viewport query (anon: public read model; authed: RLS)
└── GET /api/map/search       ✅ text search over stored address fields

Dev only (404 in production)
└── /dev/outbox               ✅ queued emails
```
