-- Runtime configuration table (admin-panel-editable settings). Hand-written
-- in the same style as every other migration in this project — see
-- 20260823000000_init's header for the verify-with-prisma-migrate-diff
-- caveat.

CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");
CREATE INDEX "AppSetting_updatedAt_idx" ON "AppSetting"("updatedAt");
