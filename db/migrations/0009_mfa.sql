-- 0009_mfa.sql
-- Authenticator-app (TOTP) multi-factor authentication. Additive.
--  * The TOTP secret is stored AES-256-GCM encrypted (key from MFA_ENCRYPTION_KEY, never in the DB).
--  * A session of an MFA-enrolled user is unusable until mfa_verified_at is set (enforced in code:
--    resolveSession reports it as pending and getCurrentUser treats it as signed out).
--  * Recovery codes are single-use and stored only as hashes.
--  * Replay protection (mfa_last_step) and lockout after repeated failures.
-- Request roles (ics_anon / ics_app) get no access to any of these columns or tables.

ALTER TABLE users
  ADD COLUMN mfa_secret_enc         text,
  ADD COLUMN mfa_pending_secret_enc text,
  ADD COLUMN mfa_last_step          bigint,
  ADD COLUMN mfa_failed_attempts    int NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until       timestamptz;

ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
-- Sessions that already exist belong to users with nothing to verify (nobody could enroll before this migration).
UPDATE sessions SET mfa_verified_at = created_at;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX mfa_recovery_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY; -- no policies: request roles see nothing
