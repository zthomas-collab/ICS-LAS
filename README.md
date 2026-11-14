# Crisis Compass

*Crisis Compass (formerly HopeGrid; repository: ICS-LAS) is the Hiraeth Ventures resource logistics, nonprofit coordination and community assistance platform. The upgrade is delivered in phases: see [09-crisis-compass-upgrade-plan](docs/09-crisis-compass-upgrade-plan.md).*

Mobile-first map that shows **where disaster-recovery resources are staged, whether they are available, who runs them, how to reach them, and when that was last confirmed** — while keeping sensitive operational sites restricted.

Not a CRM, case-management or emergency-dispatch system. The map shows resources (and, later, road conditions) only — never people or requests for help.

## Crisis Compass upgrade

- ✅ **Phase 1 (foundation):** configurable Crisis Compass branding and theme (`src/config/brand.ts`, `BRAND_*` env vars), County Administrator role scoped to assigned counties, organization profiles with logo, website, social links and counties served, administrator approval/hide of public profiles, public profile pages at `/orgs/<id>`
- ⏳ Phases 2-4 (public assistance pipeline, volunteers/donations/projects, video library/events/reports): blocked on decisions and inputs listed in the plan, notably the **scope conflict** with the repository's "no requests for help or beneficiary data" rule.

## Status of the original vertical slice

First vertical slice (Phases 0–2 + part of 3):

- ✅ One "For organizations" page with **Sign in** and **Register** tabs; registration → email confirmation → platform-admin verification (SOP-001) → suspension/reinstatement (SOP-012)
- ✅ Staging site and resource CRUD with four visibility levels, one-tap availability updates, corrections, append-only history and audit log
- ✅ Visibility enforced in PostgreSQL (roles, RLS, public read-model views, triggers) and in services
- ✅ Public MapLibre map with clustering, filters, text search, "near me", list view, stale-data banner, freshness ("Unconfirmed" after the category interval)
- ✅ Account service types (supplies, water, food, shelter, FEMA/disaster case management, healthcare, …) — admin-confirmed at approval — drive marker colors, short codes and a filterable **map legend**
- ✅ One photo per location (re-encoded, GPS/EXIF stripped), shown to exactly the people who can see the location
- ✅ Public **Contacts** at `/contacts` (the spec's Black Book): approved organizations that opted in, searchable by name, description, type and ZIP code with a radius filter — no sign-in
- ✅ Brand palette, status colors with icons + text, full map key (axe: 0 violations); brand now configurable (see above)
- ✅ 103 automated tests against real PostgreSQL 18 + PostGIS 3.6 (PGlite)
- ⏳ Road reports, restricted (authorized-only) contacts, dashboards, notification worker, managed auth/MFA — see [milestones](docs/05-milestones-acceptance.md)

**Not production-ready.** Authentication is a development adapter, no email leaves the machine, and the basemap is a free no-SLA provider. See [assumptions & risks](docs/01-assumptions-risks.md).

## Quick start

```bash
npm install
npm run db:seed
npm run admin:grant -- admin@example.test PLATFORM_ADMIN "local bootstrap"
npm run dev
```
Open http://localhost:3000. Optional: load ZIP centroids for Contacts radius search with `npm run zips:import -- <Census ZCTA gazetteer .txt>`. Sign-in links for local accounts appear at http://localhost:3000/dev/outbox. All seeded records are labelled **[SYNTHETIC]**.

## Documentation

| Doc | Contents |
|---|---|
| [00-PRD](docs/00-PRD.md) | Product requirements |
| [01-assumptions-risks](docs/01-assumptions-risks.md) | Assumptions, missing inputs, top risks |
| [02-architecture](docs/02-architecture.md) | Architecture diagram, ERD, read models |
| [03-access-matrix](docs/03-access-matrix.md) | Roles, visibility matrix, data classification |
| [04-journeys-sitemap](docs/04-journeys-sitemap.md) | User journeys, sitemap |
| [05-milestones-acceptance](docs/05-milestones-acceptance.md) | Phases, acceptance evidence, measured performance |
| [06-threat-model](docs/06-threat-model.md) | Threats and controls |
| [07-systems-audit](docs/07-systems-audit.md) | Readiness audit: public help-finding and nonprofit onboarding |
| [08-brand-and-color](docs/08-brand-and-color.md) | Original HopeGrid brand, palette, status colors, map key, contrast (palette now configurable) |
| [09-crisis-compass-upgrade-plan](docs/09-crisis-compass-upgrade-plan.md) | Crisis Compass audit, role matrix, schema plan, phases, Phase 1 deployment |
| [adr/](docs/adr/README.md) | Architecture decisions |
| [sop/SOPs](docs/sop/SOPs.md) | Administrator procedures |
| [runbook](docs/runbook.md) | Config, deploy, rollback, backup/restore |

## Layout

```
db/migrations/        SQL migrations (schema, RLS, views, SOP catalogue)
src/server/db/        drivers (pg / PGlite), migrations runner, execution contexts
src/server/modules/   identity, organizations, sites, map
src/app/              pages, server actions, /api/map/*
src/components/       map, forms, status badges
tests/                Vitest suites (real PostGIS)
scripts/              CLI (migrate, seed, admin grant) and viewport benchmark
```
