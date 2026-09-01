-- PbxRuntimeFlag (S6) — plain-boolean runtime kill switches that the Asterisk
-- dialplan reads DIRECTLY over ODBC (func_odbc.conf: RECORDING_ENABLED,
-- RECORDING_ANNOUNCE_ENABLED), the same way DNC_CHECK reads "DoNotCallEntry".
--
-- A SEPARATE table from "AppSetting" on purpose: AppSetting.valueEncrypted is
-- AES-256-GCM ciphertext (src/lib/settings/crypto.ts) and the dialplan has no
-- way to decrypt it. This table holds a bare boolean the SQL layer can read.
--
-- Written only by POST /api/admin/recording (requireAdminSession, AuditLog).
-- Hand-written in the same style as every other migration here — see
-- 20260823000000_init's header for the prisma-migrate-diff caveat. Not modelled
-- in schema.prisma (S2a owns that file this wave); the API uses $queryRaw.

CREATE TABLE "PbxRuntimeFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    CONSTRAINT "PbxRuntimeFlag_pkey" PRIMARY KEY ("key")
);

-- Seed both flags ON. This preserves today's behaviour exactly: recording is
-- currently unconditional, and the declaration is the compliance counterpart
-- that must be on whenever recording is. Fail-open in the dialplan already
-- covers the window before this migration is deployed.
INSERT INTO "PbxRuntimeFlag" ("key", "enabled") VALUES
    ('recording_enabled', true),
    ('recording_announcement_enabled', true);
