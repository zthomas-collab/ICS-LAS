# Threat Model (Phase 0, STRIDE-lite)

Assets: restricted site coordinates and inventory; org accounts and editing rights; integrity of public availability; contact PII; audit history; service availability during disasters.

| # | Threat | Vector | Control in this slice | Remaining work |
|---|---|---|---|---|
| T1 | **Information disclosure** of restricted sites | Anonymous API, search, caching, error messages | `ics_anon` can read only whitelisted views; RLS for `ics_app`; authed responses `no-store`; generic error messages; tests | Export endpoints must reuse the same contexts; CDN config review |
| T2 | Leaky-function attack on non-barrier views | Attacker-defined function in WHERE | `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; request roles cannot create functions | Periodic grant audit in CI |
| T3 | **Elevation of privilege** across orgs | Forged org id, edited form fields | `can_edit_org` in service + RLS `WITH CHECK`; org id never taken from row updates; tests for cross-org edit/move | — |
| T4 | Self-approval / admin escalation | Pending rep calls admin action | `assertPlatformAdmin` re-checked in transaction; not cached from session | MFA (blocked on managed auth) |
| T5 | SQL injection resetting `ics.viewer_id` or `ROLE` | Untrusted SQL text | All queries parameterized; only migrations use `exec` | Lint rule forbidding template-literal SQL with user data |
| T6 | **Spoofing** via magic-link interception or scanner consumption | Email | Hashed, single-use, 15 min sign-in tokens; POST to consume; no account enumeration on sign-in | Replace with managed auth + MFA/WebAuthn |
| T7 | Session theft | XSS, cookie leakage | httpOnly, SameSite=Lax, `__Host-` + Secure in prod; CSP; server-side revocation | Nonce-based CSP (remove `unsafe-inline`) |
| T8 | CSRF | Cross-site form posts | Next.js server actions verify Origin; SameSite cookies | — |
| T9 | **Tampering** with history | Direct UPDATE/DELETE | Append-only triggers on events, audit, verifications | Off-database WORM log shipping |
| T10 | Misinformation by approved org | Malicious/negligent updates | Provenance on every change; suspension (SOP-012); freshness expiry | Complaint workflow (SOP-011) |
| T11 | Scraping / DoS | Bulk viewport queries | Per-IP/user fixed-window rate limits; bbox span cap (12°); result cap (1000) | Shared limiter (Redis/WAF), bot detection at edge |
| T12 | Location privacy of visitors | "Near me" | Geolocation only client-side; server receives viewport only; IPs not logged | Privacy policy |
| T13 | Unsafe reliance on road reports | Treating reports as official | Separate `official_status` with DB CHECK requiring source + verifier | Phase 5 UI labels and tests |
| T14 | Malicious or privacy-leaking site photos | Uploads | Bytes sniffed (JPEG/PNG/WebP only, never trusting filename/MIME); decoded and **re-encoded to WebP** with sharp (drops EXIF/GPS/XMP/ICC, neutralizes polyglots); pixel limit 40 MP; 5 MB cap; served only through an authorization-checked route with `nosniff`; restricted-site photos `private, no-store`; storage keys never sent to clients | AV scanning not configured (rows `NOT_SCANNED`); managed private object storage (M5); retention job for archived photos; moderation queue |
| T17 | Contacts (Black Book) scraping / harassment of contacts | Public directory | Only orgs that opted in; only public channels; consent withdrawal is immediate; 200-row cap | Edge rate limiting / bot protection for `/contacts` |
| T18 | Wrong or abusive service type on the map | Org self-labels | Main type is admin-confirmed at approval and only admins can change it (audited) | — |
| T15 | Dev auth or PGlite in production | Misconfiguration | Both throw when `NODE_ENV=production` unless explicitly overridden | Deployment checklist gate |
| T16 | Log leakage | PII/tokens in logs | Structured error logs contain message only; tokens never logged | Central log redaction tests |
