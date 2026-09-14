import { tenantDb } from "@/lib/db-tenant";
import { unsafeGlobalDb } from "@/lib/db";
import { ensureSystemActorId } from "@/lib/support-grant";
import { normalizeToE164 } from "@/lib/phone-normalize";
import type { AiComplianceCheckInput, AiComplianceDecision } from "@/lib/ai/types";

// Outbound-compliance gate for AI voice agents (LLM.md "Hybrid AI + Human"
// decision, node W8). Called by W6's agent-config route (and any future
// outbound-origination path) before an AI agent is allowed to place a call —
// never before answering an inbound one (agent-config's own comment: inbound
// is always allowed unless AiAgent.enabled === false, which is a separate,
// simpler gate that route already applies itself).
//
// Regulatory framing (see LLM.md's research notes; this is deliberately a
// conservative reading, not a certified legal opinion):
//   - India (agents are India-based, and Indian mobile destinations are the
//     most likely accidental target): TRAI's telemarketing regime routes
//     commercial calls through registered 140-series ("promotional")/1600-
//     series ("service/transactional") principal entity numbers, and TRAI's
//     National Customer Preference Register (NCPR/DND) prohibits unsolicited
//     commercial communication to a registered number. An AI agent dialing
//     out through this system's plain E.164 numbers, with no telemarketer
//     registration, has no safe way to distinguish "this destination is fine
//     to call" from "this violates TRAI DND" other than the tenant's own
//     allowlist/DNC data — hence the hard DoNotCallEntry check below.
//   - UAE (the Dinstar GSM trunk is UAE-based, so UAE-destined traffic
//     transits UAE telecom law regardless of who's calling): TDRA's
//     anti-spam framework requires prior consent for marketing
//     communications, restricts marketing calls to a 09:00-18:00 local
//     window, and — analogous to India's NCPR — a called party can register
//     on TDRA's Do Not Call Registry (DNCR) to refuse marketing contact.
//   - Because this system cannot itself verify "was consent obtained" or
//     "is this call transactional vs. marketing" — that's a fact about the
//     tenant's business, not something inferable from a phone number —
//     `AiAgent.outboundEnabled` ships `false` (schema default) and stays
//     false until a tenant admin explicitly opts an agent into outbound
//     dialing. The risk being defended against is specifically the
//     GSM-gateway "automated marketing at scale" failure mode: an
//     unattended AI agent with an LLM-driven call list could otherwise dial
//     thousands of numbers a day through the Dinstar trunk with no human in
//     the loop and no per-call consent check, which is exactly the pattern
//     both TRAI and TDRA enforcement target. `callHoursStart/End` and
//     `allowedDestinations` give the tenant the same two knobs (time window,
//     destination scope) both regulators' frameworks are built around.
//
// None of this replaces the tenant's own legal responsibility for consent
// and registration — this module only enforces what the schema encodes.

/** [start, end) local-hour window check, handling the case where the window
 * wraps midnight (e.g. start=22, end=6 means "22:00 through 05:59"). Pure
 * and exported for direct unit testing rather than only via checkOutbound's
 * DB-backed branches. */
export function isWithinCallHours(localHour: number, start: number, end: number): boolean {
  if (start === end) {
    // A zero-width window is nonsensical as "closed all day" and
    // indistinguishable from "open all day" without a documented
    // convention; treat it as no restriction rather than silently
    // blocking every call a misconfigured agent ever attempts.
    return true;
  }
  if (start < end) {
    return localHour >= start && localHour < end;
  }
  // Wraps midnight: e.g. start=22, end=6 -> allowed hours are
  // {22,23,0,1,2,3,4,5}.
  return localHour >= start || localHour < end;
}

/** Local hour (0-23) at the destination, given the platform's current UTC
 * instant and the destination's UTC offset in minutes. Pure and exported
 * for unit testing. */
export function destinationLocalHour(nowUtc: Date, destinationLocalUtcOffsetMinutes: number): number {
  const localMs = nowUtc.getTime() + destinationLocalUtcOffsetMinutes * 60_000;
  const localDate = new Date(localMs);
  // Use the UTC getters on the shifted instant so this is independent of the
  // host process's own timezone (server runs in UTC or IST, doesn't matter).
  const hour = localDate.getUTCHours();
  return ((hour % 24) + 24) % 24;
}

async function auditDecision(
  tenantId: string,
  agentId: string,
  destinationE164: string,
  decision: AiComplianceDecision
): Promise<void> {
  // AuditLog.actorId is a required FK to (tenant-scoped) User — an AI agent
  // has no User row (Extension.userId is null for agentType "AI"), so this
  // reuses the exact same per-tenant "system actor" pattern support-grant.ts
  // established for platform-plane writes into tenant AuditLog: one
  // deterministic, disabled, passwordless User row per tenant that exists
  // solely to be a legible FK target, with the real context (agentId,
  // destination, decision) carried in metadata instead.
  const actorId = await ensureSystemActorId(unsafeGlobalDb, tenantId);
  await tenantDb(tenantId).auditLog.create({
    data: {
      tenantId,
      action: "ai.compliance_check",
      actorId,
      targetId: agentId,
      metadata: {
        agentId,
        destinationE164,
        allowed: decision.allowed,
        reason: decision.reason ?? null,
      },
    },
  });
}

/**
 * Decides whether an AI agent may originate an outbound call to
 * `input.destinationE164` right now. AI agents are never geo-locked (they
 * have no login/session — see auth.ts's Credentials authorize() and
 * /api/me/sip-credentials, both keyed off a User session an AI extension
 * structurally never has); this is the equivalent gate for them, driven
 * entirely by the per-agent compliance fields on `AiAgent`.
 *
 * Every call is audited, allowed or denied — see `auditDecision` above.
 */
export async function checkOutbound(input: AiComplianceCheckInput): Promise<AiComplianceDecision> {
  const db = tenantDb(input.tenantId);

  const agent = await db.aiAgent.findUnique({
    where: { id: input.agentId },
    select: {
      enabled: true,
      outboundEnabled: true,
      allowedDestinations: true,
      callHoursStart: true,
      callHoursEnd: true,
    },
  });

  if (!agent || !agent.enabled) {
    const decision: AiComplianceDecision = { allowed: false, reason: "agent not found or disabled" };
    await auditDecision(input.tenantId, input.agentId, input.destinationE164, decision);
    return decision;
  }

  // Default-safe path — checked even though everything below could
  // otherwise pass, since AiAgent.outboundEnabled defaults false precisely
  // to stop an unattended agent from dialing out until an admin opts it in.
  if (!agent.outboundEnabled) {
    const decision: AiComplianceDecision = {
      allowed: false,
      reason: "outbound calling is disabled for this agent",
    };
    await auditDecision(input.tenantId, input.agentId, input.destinationE164, decision);
    return decision;
  }

  // Destination allowlist. Per the schema's own comment, an EMPTY list on an
  // outbound-enabled agent means "no restriction", not "deny everything" —
  // the "no outbound dialing at all" case is `outboundEnabled: false`,
  // already handled above.
  if (agent.allowedDestinations.length > 0) {
    const matches = agent.allowedDestinations.some((prefix) => input.destinationE164.startsWith(prefix));
    if (!matches) {
      const decision: AiComplianceDecision = { allowed: false, reason: "destination not in allowedDestinations" };
      await auditDecision(input.tenantId, input.agentId, input.destinationE164, decision);
      return decision;
    }
  }

  // Call-hours window, in the destination's local time.
  if (agent.callHoursStart !== null && agent.callHoursEnd !== null) {
    const localHour = destinationLocalHour(input.nowUtc, input.destinationLocalUtcOffsetMinutes);
    if (!isWithinCallHours(localHour, agent.callHoursStart, agent.callHoursEnd)) {
      const decision: AiComplianceDecision = { allowed: false, reason: "outside permitted calling hours" };
      await auditDecision(input.tenantId, input.agentId, input.destinationE164, decision);
      return decision;
    }
  }

  // DND/DNCR check — the existing tenant-scoped DoNotCallEntry table already
  // backs the human-dialing pre-dial guard; normalize the same way
  // dnc-import.ts/contact-import.ts do before comparing so formatting
  // differences (e.g. missing "+") can't slip a listed number through.
  const normalizedDestination = normalizeToE164(input.destinationE164) ?? input.destinationE164;
  const dncHit = await db.doNotCallEntry.findUnique({
    where: { tenantId_numberE164: { tenantId: input.tenantId, numberE164: normalizedDestination } },
  });
  if (dncHit) {
    const decision: AiComplianceDecision = { allowed: false, reason: "destination is on the Do Not Call list" };
    await auditDecision(input.tenantId, input.agentId, input.destinationE164, decision);
    return decision;
  }

  const decision: AiComplianceDecision = { allowed: true };
  await auditDecision(input.tenantId, input.agentId, input.destinationE164, decision);
  return decision;
}

// --- AI -> human escalation compliance gate (LLM.md §34.2's plan,
// Workstream G) ---------------------------------------------------------
//
// The escalation dial (an AI agent placing an outbound call to a phone
// number configured as its handoff target, over the GSM trunk - see
// src/app/api/internal/ai/escalate/route.ts) IS an AI-originated outbound
// call, which is exactly what `checkOutbound()` above exists to gate. But
// it is NOT the same risk `checkOutbound()`/`outboundEnabled` were built
// for: `outboundEnabled` guards against an unattended agent working through
// an LLM-driven call list at scale (the TRAI/TDRA "automated marketing"
// failure mode described in this file's header). An escalation dial is the
// opposite shape - one call, to one fixed, admin-configured number, made
// only because a specific caller asked for a human right now. Gating it on
// `outboundEnabled` would conflate two different risk profiles and force a
// tenant to accept marketing-dial risk just to let their AI transfer calls.
// Gating it on `escalationEnabled` instead keeps them independent.
//
// Deliberately does NOT check callHoursStart/callHoursEnd: those exist to
// stop an AI from ORIGINATING contact at 3am local time, which presumes the
// call is unsolicited. An escalation dial is never unsolicited - the human
// on the other end of this AudioSocket connection is asking, right now, to
// be connected to a colleague. Whether staff are actually available to
// answer is what escalate/route.ts's own `check` action (GSM capacity,
// OriginateResponse) already determines; a regulatory hours gate has
// nothing to add there and would only produce a confusing "it's after
// hours" apology for a caller who is not the one placing the call.
//
// DNC stays non-bypassable: escalate/route.ts routes a NUMBER target
// through `Local/<n>@from-agent-<tier>/n`, which runs the dialplan's own
// DNC_CHECK() regardless of this function's result - this is the app-layer
// check IN ADDITION to that, same defense-in-depth relationship
// checkOutbound() already has with the dialplan's DNC_CHECK for ordinary
// outbound calls.
//
// ⚠️ WIRED into escalate/route.ts's `check`/`merge` (see that file's
// checkCompliance() helper) - a NUMBER target failing this gate is refused
// exactly like a GSM-capacity refusal (the AI offers wait/callback instead)
// BEFORE anything touches AMI. Still needs explicit owner sign-off before
// enabling AiAgent.escalationEnabled with a NUMBER target for a real
// tenant, though: this function encodes an engineering judgment call (is a
// DND-registered number reachable for a caller-INITIATED transfer, the
// same way `checkOutbound()`'s header explains its own DND check is a
// conservative reading, not a certified legal opinion) - the code path
// being live is not the same as the business decision being signed off.
// Record that sign-off in LLM.md when it happens.

export interface AiEscalationComplianceInput {
  tenantId: string;
  agentId: string;
  destinationE164: string;
}

/**
 * Decides whether an AI agent may dial `input.destinationE164` as an
 * escalation target right now. See the module comment above for exactly
 * how and why this differs from `checkOutbound()`. Every call is audited,
 * allowed or denied, under a distinct `ai.escalation_compliance_check`
 * action so it's never conflated with an ordinary outbound-dial decision
 * in the audit log.
 */
export async function checkEscalationDial(input: AiEscalationComplianceInput): Promise<AiComplianceDecision> {
  const db = tenantDb(input.tenantId);

  const agent = await db.aiAgent.findUnique({
    where: { id: input.agentId },
    select: { enabled: true, escalationEnabled: true, allowedDestinations: true },
  });

  if (!agent || !agent.enabled) {
    const decision: AiComplianceDecision = { allowed: false, reason: "agent not found or disabled" };
    await auditEscalationDecision(input.tenantId, input.agentId, input.destinationE164, decision);
    return decision;
  }

  if (!agent.escalationEnabled) {
    const decision: AiComplianceDecision = { allowed: false, reason: "escalation is disabled for this agent" };
    await auditEscalationDecision(input.tenantId, input.agentId, input.destinationE164, decision);
    return decision;
  }

  // Same "empty list = no restriction" polarity as checkOutbound() above -
  // a tenant that HAS configured a destination allowlist for this agent
  // still has it enforced against the escalation target.
  if (agent.allowedDestinations.length > 0) {
    const matches = agent.allowedDestinations.some((prefix) => input.destinationE164.startsWith(prefix));
    if (!matches) {
      const decision: AiComplianceDecision = { allowed: false, reason: "destination not in allowedDestinations" };
      await auditEscalationDecision(input.tenantId, input.agentId, input.destinationE164, decision);
      return decision;
    }
  }

  const normalizedDestination = normalizeToE164(input.destinationE164) ?? input.destinationE164;
  const dncHit = await db.doNotCallEntry.findUnique({
    where: { tenantId_numberE164: { tenantId: input.tenantId, numberE164: normalizedDestination } },
  });
  if (dncHit) {
    const decision: AiComplianceDecision = { allowed: false, reason: "destination is on the Do Not Call list" };
    await auditEscalationDecision(input.tenantId, input.agentId, input.destinationE164, decision);
    return decision;
  }

  const decision: AiComplianceDecision = { allowed: true };
  await auditEscalationDecision(input.tenantId, input.agentId, input.destinationE164, decision);
  return decision;
}

async function auditEscalationDecision(
  tenantId: string,
  agentId: string,
  destinationE164: string,
  decision: AiComplianceDecision
): Promise<void> {
  const actorId = await ensureSystemActorId(unsafeGlobalDb, tenantId);
  await tenantDb(tenantId).auditLog.create({
    data: {
      tenantId,
      action: "ai.escalation_compliance_check",
      actorId,
      targetId: agentId,
      metadata: {
        agentId,
        destinationE164,
        allowed: decision.allowed,
        reason: decision.reason ?? null,
      },
    },
  });
}
