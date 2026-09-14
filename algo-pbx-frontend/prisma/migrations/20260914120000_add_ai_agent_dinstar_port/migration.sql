-- Follow-up to §34 (LLM.md, 2026-09-14) — per-port AI agent assignment.
--
-- STRICTLY ADDITIVE:
--   * AiAgent gets a new nullable "dinstarPort" column (1-4, matching
--     WaInstance.simPort's exact numbering convention for the same Dinstar
--     UC2000 hardware) plus a composite unique index on
--     (tenantId, dinstarPort). Postgres unique indexes treat multiple NULLs
--     as non-conflicting, so this allows any number of agents that are not
--     yet assigned to a GSM port (internal-dial-only) while enforcing at
--     most one enabled-or-not agent per port per tenant at the DB layer —
--     the same guarantee WaInstance's own
--     `@@unique([tenantId, simPort])` gives the WhatsApp/SMS side.
--
-- This does NOT touch the existing cross-tenant "only one tenant may have
-- an enabled AI agent at a time" guard in
-- api/admin/ai/agents/route.ts / [id]/route.ts — that guard filters on
-- `tenantId: { not: <this agent's tenantId> }` and was never blocking two
-- agents on the SAME tenant, so it needs no schema or app-layer change for
-- this feature (see this migration's accompanying LLM.md entry).

-- --- AiAgent.dinstarPort -----------------------------------------------------
ALTER TABLE "AiAgent" ADD COLUMN "dinstarPort" INTEGER;

CREATE UNIQUE INDEX "AiAgent_tenantId_dinstarPort_key" ON "AiAgent"("tenantId", "dinstarPort");
