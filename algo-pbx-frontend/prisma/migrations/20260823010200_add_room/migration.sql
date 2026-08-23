-- Workstream E — Rooms (admin-defined saved view over agents/queues/WA
-- instances). Append-only, same hand-written-pending-live-diff caveat as
-- every other migration in this batch — see 20260823000000_init's header.

CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memberUserIds" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Room_name_key" ON "Room"("name");
