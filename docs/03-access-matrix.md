# D. Role / Permission and Data Visibility Matrix

## Roles

| Role | How obtained | Scope |
|---|---|---|
| Public visitor | none | — |
| Pending org representative | registers + confirms email | own org (read) |
| Org VIEWER / EDITOR / ORG_ADMIN | membership in an **APPROVED** org | own org |
| AUTHORIZED_RESPONDER | `role_assignments`, granted by platform admin (SOP-010) | **required** `scope_area` polygon, optional `org_id`, optional expiry |
| ROAD_VERIFIER | `role_assignments` | road reports (Phase 5) |
| PLATFORM_ADMIN | `role_assignments` (CLI bootstrap, then admin grant) | platform; MFA required in production |
| SECURITY_ADMIN | `role_assignments` | revocations, audit (Phase 6–7) |

Verification (org status) and operational authority (responder role) are independent: an approved nonprofit does **not** see responder-only logistics unless a member also holds a scoped responder assignment.

## Site and resource visibility (enforced by RLS + views; tested in `tests/visibility.test.ts`)

| Viewer ↓ / Record visibility → | PUBLIC | ORGANIZATION_NETWORK | AUTHORIZED_RESPONDERS | PRIVATE_ORGANIZATION |
|---|---|---|---|---|
| Anonymous | ✅ | ❌ | ❌ | ❌ |
| Signed in, no approved org | ✅ | ❌ | ❌ | ❌ |
| Member of pending/suspended org | ✅ | ❌ | ❌ | ❌ (own org's: ✅ read) |
| Member of another approved org | ✅ | ✅ (unless `site_access_policies` allow-list excludes them) | ❌ | ❌ |
| Authorized responder | ✅ | only if also approved-org member | ✅ **inside scope_area** (and scope org) | ❌ |
| Owning org (any active role) | ✅ | ✅ | ✅ | ✅ (incl. archived) |
| Platform admin | ✅ | ✅ | ✅ | ✅ |

Additional rules: archived sites/resources and sites of suspended or unapproved orgs are invisible to everyone except the owning org and platform admins. A resource is visible only if its site is visible **and** its own level admits the viewer; a resource may never be more visible than its site (DB trigger).

## Actions

| Action | Public | Pending rep | Org VIEWER | Org EDITOR | ORG_ADMIN | Responder | Platform admin |
|---|---|---|---|---|---|---|---|
| Browse public map/list/search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Register organization | ✅ | — | — | — | — | — | — |
| Create/edit/archive own org's sites & resources | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ (moderation; edit) |
| Update availability / confirm | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| View own org's change history | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Approve / reject / suspend / reinstate orgs | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Grant platform/responder roles | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | CLI now; UI Phase 6 |
| Invite/revoke staff | ❌ | ❌ | ❌ | ❌ | Phase 4 | ❌ | ✅ |

## Data classification

| Class | Examples | Handling |
|---|---|---|
| **Public** | Public site name/location/address/hours/public phone, public resources and status, org display name | May be cached (10 s) and indexed |
| **Network-restricted** | ORGANIZATION_NETWORK sites | Authenticated only; `no-store`; never in public views |
| **Operationally sensitive** | AUTHORIZED_RESPONDERS sites, restricted equipment/fuel, staging yards | Scoped responders only; never exported; never in search suggestions for others |
| **Private org** | PRIVATE_ORGANIZATION sites, history, before/after snapshots | Owning org + admins |
| **Personal (PII)** | user emails, names, org contact email, registration notes, session/token hashes, IPs | Never in public payloads; `contact_email` not granted to `ics_app`; IPs used only in memory for rate limiting; not logged |
| **Security** | session tokens, magic-link tokens | Stored only as SHA-256 hashes; httpOnly cookies |
| **Prohibited** | individual requests for help, people needing help, beneficiary data | Not collected. No tables exist for them. |
