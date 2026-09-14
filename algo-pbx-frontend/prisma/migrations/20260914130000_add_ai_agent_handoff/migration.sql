-- AI -> human escalation, Workstream F (schema half) — follow-up to §34/§34.1
-- (LLM.md §34.2, 2026-09-14). Full design at
-- ~/.claude/plans/we-have-succeesfully-forked-crispy-petal.md.
--
-- STRICTLY ADDITIVE. AiAgent gains:
--   * "escalationEnabled" (default false — ships off, same polarity as
--     outboundEnabled/dinstarPort).
--   * "handoffTargetKind" ("NUMBER" | "EXTENSION" | null).
--   * "handoffNumberE164" — the number the AI dials out over the GSM trunk
--     from its own extension (the owner's primary requirement; gated live
--     by the single-active-SIM hardware limit — see
--     src/lib/transfer-guard.ts's live-confirmed SIP trace).
--   * "handoffExtensionId" — an optional FK to a same-tenant, HUMAN-kind
--     Extension (app-layer validated in api/admin/ai/agents/[id]/route.ts,
--     same pattern as that route's existing CREDENTIAL_ID_FIELDS check).
--     ON DELETE SET NULL, matching this schema's existing convention for
--     every other optional FK (e.g. Contact.companyId) — deleting the
--     target extension must not fail or cascade-delete the AiAgent, only
--     clear the now-dangling reference.

-- --- AiAgent escalation columns ---------------------------------------------
ALTER TABLE "AiAgent" ADD COLUMN "escalationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiAgent" ADD COLUMN "handoffTargetKind" TEXT;
ALTER TABLE "AiAgent" ADD COLUMN "handoffNumberE164" TEXT;
ALTER TABLE "AiAgent" ADD COLUMN "handoffExtensionId" TEXT;

CREATE INDEX "AiAgent_handoffExtensionId_idx" ON "AiAgent"("handoffExtensionId");

ALTER TABLE "AiAgent" ADD CONSTRAINT "AiAgent_handoffExtensionId_fkey" FOREIGN KEY ("handoffExtensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;
