# Administrator SOPs

Machine-readable definitions for all 14 SOPs live in `operational_sop_definitions` (migration `0003_sop_definitions.sql`): trigger, initiating role, required fields, responsible party, action, deadline, exception path, escalation, evidence, completion. This document is the operator-facing procedure for the SOPs that the current slice supports. SOPs marked ⏳ have definitions but no tooling yet — follow the manual fallback.

## SOP-001 Organization Verification ✅
1. Open **Admin → Organizations awaiting approval**. Items past the 48 h due time show **Overdue**.
2. Verify, from sources you find independently (not links supplied by the registrant): legal existence (IRS Tax Exempt Organization Search / state registry), mission fit, and that the registrant works there (call the organization's publicly listed number).
3. Record what you checked in **Evidence summary** — sources and dates, never full ID numbers or personal documents.
4. **Approve** or **Reject**. The decision, reviewer and evidence are stored append-only; SOP execution closes; the registrant is notified.
5. Exception: insufficient evidence → leave pending and contact the registrant out-of-band. Suspected fraud → **Reject** and inform the security administrator.

## SOP-002 Staging Site Creation ✅ (org editors)
Use the least visibility that serves the purpose. Never mark a private warehouse, responder staging yard, or any site whose disclosure could invite theft or crowding as **Public**. Verify the pin location before saving (the form shows a warning for Public).

## SOP-003 Immediate Availability Update ✅ (org editors)
On any change on the ground, open the site and tap the new status (Available / Limited / Depleted / Temporarily closed / Unknown). If unsure, choose **Unknown** — never leave a stale **Available**.

## SOP-004 Quantity and Status Correction ✅
Use **Update quantity / record correction**, tick **This corrects a previous wrong value**, and explain in **Note**. Corrections are labelled in history; nothing is overwritten.

## SOP-005 Stale Resource Reconfirmation 🟡
Automatic part ✅: once a listing passes its category interval it is shown as **Unconfirmed** and excluded from "confirmed only". Manual part until the reminder worker ships: editors check their dashboard at the start of each operational period and press **Still accurate** or update.

## SOP-012 Emergency Data Publication Suspension ✅
1. **Admin → Organizations** → find the org → enter the reason → **Suspend publication**.
2. Effect is immediate: every listing of that org disappears from public and network maps; editing is disabled.
3. If account compromise is suspected, also perform SOP-013.
4. **Reinstate** only with documented evidence that the issue is resolved.

## SOP-013 Staff Access Revocation 🟡
UI pending (Phase 4). Manual procedure (security administrator, against the production database, inside a transaction, with a second person reviewing):
```sql
UPDATE organization_memberships SET status = 'REVOKED', revoked_at = now() WHERE user_id = '<user>' AND org_id = '<org>';
UPDATE sessions SET revoked_at = now() WHERE user_id = '<user>' AND revoked_at IS NULL;
INSERT INTO audit_logs (actor_user_id, action, subject_type, subject_id, details)
VALUES ('<your user id>', 'MEMBERSHIP_REVOKED', 'user', '<user>', '{"reason":"<reason>"}');
```
Effect is immediate (verified by tests): the next request has no edit access.

## SOP-006 … SOP-011, SOP-014 ⏳
See definitions in the database. Until tooling exists: road observations are not accepted through the platform; Black Book is not published; incorrect-information complaints go to the owning org's public phone and to the platform admin, who can suspend (SOP-012); outages follow `docs/runbook.md`.
