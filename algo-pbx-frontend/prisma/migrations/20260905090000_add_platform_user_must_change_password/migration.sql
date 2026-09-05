-- Platform-plane owner bootstrap (2026-09-05): adds the column the new
-- web-based /platform/setup flow uses to force a password change after a
-- script-issued one-time password. Additive-only, default false, so every
-- existing PlatformUser row (already onboarded) is unaffected.
ALTER TABLE "PlatformUser" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
