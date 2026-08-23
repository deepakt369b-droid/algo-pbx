-- Workstream F — internal MCP server approval tokens.
--
-- Hand-written in the same style as 20260823000000_init/migration.sql and
-- for the same reason: no Postgres instance is reachable from the
-- environment this was authored in, so `prisma migrate dev` could not
-- generate the diff itself. Verify with `prisma migrate diff` against a
-- throwaway dev database before trusting it in a real deployment.
--
-- Append-only: touches no existing table. `mintedByAdminId` deliberately
-- carries NO foreign key to "User" — see the schema.prisma comment above
-- model McpApproval for why (the relation would require editing the User
-- model, which this workstream may not do).

-- McpApproval
CREATE TABLE "McpApproval" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mintedByAdminId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpApproval_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "McpApproval_tokenHash_key" ON "McpApproval"("tokenHash");
CREATE INDEX "McpApproval_expiresAt_idx" ON "McpApproval"("expiresAt");
CREATE INDEX "McpApproval_mintedByAdminId_idx" ON "McpApproval"("mintedByAdminId");
