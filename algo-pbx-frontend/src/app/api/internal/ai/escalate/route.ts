import { randomInt, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getAmiClient, type AmiClient, type AmiEvent } from "@/lib/ami-client";
import { withApiErrorHandler } from "@/lib/api-handler";
import { isAuthorizedInternalAiRequest } from "@/app/api/internal/ai/_auth";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb, type TenantClient } from "@/lib/db-tenant";
import { checkEscalationDial } from "@/lib/ai/compliance";
import { ensureSystemActorId } from "@/lib/support-grant";
import { createTask } from "@/lib/crm/tasks-data";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// POST /api/internal/ai/escalate — AI -> human escalation orchestration
// (LLM.md §34.2's plan, Workstream C). The Python sidecar calls this once
// its LLM emits a `request_human_handoff` tool call (pipeline/tools.py);
// this route owns every AMI action involved (CoreShowChannels/Redirect/
// Originate/waitForEvent) — the sidecar has no AMI credentials at all (see
// docker-compose.yml's ai-voice-agent service, which never sets AMI_*) and
// its own AmiClient (ai-voice-agent/handoff.py) can only send a single
// action and read a single response block, not the multi-event
// CoreShowChannels/waitForEvent sequences this flow needs.
//
// Tenant is ALWAYS resolved here from `agentId` via `unsafeGlobalDb`, never
// accepted from the request body — the dialplan's own AI_TENANT_ID channel
// variable is empty today (extensions.conf's own comment on this), so the
// sidecar cannot be trusted to know its own tenant. Same pattern
// src/lib/ai/sessions.ts's recordAiSession() already established.
//
// ARCHITECTURE NOTE, found while implementing (not in the original plan
// draft): the plan's Workstream C originally had Next.js POST directly to
// the sidecar's own pre-registration HTTP server at 127.0.0.1:9091/register
// before Originating the AI's conference leg. That is NOT reachable from
// here — `web` runs on the bridge network (algo-net), not
// `network_mode: host` like `ai-voice-agent`/`asterisk` do (see
// docker-compose.yml), and the sidecar's PREREG_HOST is deliberately bound
// to 127.0.0.1 ONLY (a prior security fix — see main.py's own comment on
// why 0.0.0.0 there would be a public-internet exposure). `web` reaching
// Asterisk's AMI works via `host.docker.internal:5038` because manager.conf
// listens broadly; the sidecar's loopback-only HTTP server has no
// equivalent reachable address from a bridge container. Fix: the AI's
// conference leg pre-registers itself via the SAME dialplan CURL()
// mechanism `[ai-agent-internal]`/`[from-dinstar-ai]` already use and have
// proven reachable (Asterisk is host-networked, same as the sidecar) —
// everything the CURL() body needs (the new leg's UUID, which call it
// resumes, the tenant, the AI's own extension number) is threaded through
// as channel variables on the Originate action's `Variable:` field instead.
// See pbx_configs/extensions.conf's `[ai-conference-leg]` context.
//
// Also found and fixed alongside this route (docker-compose.yml): `web`'s
// own environment block never set AI_SIDECAR_SHARED_SECRET at all, so
// isAuthorizedInternalAiRequest() was failing closed on every request from
// the sidecar to the two existing /api/internal/ai/* routes — a
// pre-existing bug, not introduced here, fixed as part of the same pass
// since this route depends on the same secret being correct.

const AI_CONFERENCE_CONTEXT = "ai-conference";
const AI_CONFERENCE_LEG_CONTEXT = "ai-conference-leg";
const GSM_TRUNK_PREFIX = "PJSIP/dinstar-trunk-";
const AI_CONFERENCE_LEG_CHANNEL_PREFIX = "Local/ai@";

// Only src/app/api/internal/ai/escalate/route.ts reads this — see
// .env.example's comment. Read once per module load, not per request:
// matches the rest of this codebase's convention for fixed deployment
// config (contrast with per-tenant DB-backed settings).
const GSM_TRUNK_CAPACITY = Number.parseInt(process.env.GSM_TRUNK_CAPACITY ?? "1", 10) || 1;

const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check"), agentId: z.string(), callUuid: z.string().uuid() }),
  z.object({ action: z.literal("merge"), agentId: z.string(), callUuid: z.string().uuid() }),
  z.object({
    action: z.literal("callback"),
    agentId: z.string(),
    callUuid: z.string().uuid(),
    reason: z.string().max(2000).optional(),
  }),
]);

type UnavailableReason =
  | "agent_not_found"
  | "escalation_disabled"
  | "agent_extension_missing"
  | "no_target_configured"
  | "call_not_found"
  | "gsm_capacity"
  | "ai_leg_originate_failed"
  | "ai_leg_join_timeout"
  | "caller_hung_up"
  | "compliance_denied";

type CallbackFailureReason = "agent_not_found" | "call_not_found" | "caller_number_unknown" | "no_assignee_available";

interface ResolvedTarget {
  tenantId: string;
  aiExtensionNumber: string;
  targetKind: "NUMBER" | "EXTENSION";
  /** The exact AMI Originate `Channel` value for the human leg. */
  targetChannel: string;
  /** Human-readable — logged/audited, never sent back to the caller as the
   * sole identifier (session_reporter.py's handoff_extension_id carries
   * this once Workstream B exists). */
  targetLabel: string;
}

type ResolveResult = { ok: true; target: ResolvedTarget } | { ok: false; reason: UnavailableReason };

/** Resolves an AiAgent's configured escalation target into something AMI
 * can dial, WITHOUT touching AMI itself — shared by both `check` and
 * `merge` so a `merge` call is safe to make standalone (never trusts a
 * prior `check` call was authoritative; there is no session/lock between
 * the two calls, so re-deriving from the DB here is the only correct
 * option, not a redundant one). */
async function resolveEscalationTarget(agentId: string): Promise<ResolveResult> {
  const agent = await unsafeGlobalDb.aiAgent.findUnique({
    where: { id: agentId },
    select: {
      tenantId: true,
      escalationEnabled: true,
      handoffTargetKind: true,
      handoffNumberE164: true,
      handoffExtension: { select: { number: true } },
      extension: { select: { number: true, dialPermission: true } },
    },
  });
  if (!agent) return { ok: false, reason: "agent_not_found" };
  if (!agent.escalationEnabled) return { ok: false, reason: "escalation_disabled" };
  if (!agent.extension) return { ok: false, reason: "agent_extension_missing" };

  if (agent.handoffTargetKind === "NUMBER" && agent.handoffNumberE164) {
    // Same SECURITY rule as api/calls/conference/route.ts:110-129: an
    // external number is NEVER Originated straight at
    // `PJSIP/<n>@dinstar-trunk` (bypasses dial tiers, the emergency block,
    // and DNC_CHECK()). Route through a Local channel executing the AI's
    // OWN extension's dial-permission context instead — mirroring that
    // route's use of the acting agent's own dialPermission, just with the
    // AI's extension standing in for a human agent's.
    const tier = agent.extension.dialPermission.toLowerCase();
    const digits = agent.handoffNumberE164.replace(/^\+/, "");
    return {
      ok: true,
      target: {
        tenantId: agent.tenantId,
        aiExtensionNumber: agent.extension.number,
        targetKind: "NUMBER",
        targetChannel: `Local/${digits}@from-agent-${tier}/n`,
        targetLabel: agent.handoffNumberE164,
      },
    };
  }

  if (agent.handoffTargetKind === "EXTENSION" && agent.handoffExtension) {
    return {
      ok: true,
      target: {
        tenantId: agent.tenantId,
        aiExtensionNumber: agent.extension.number,
        targetKind: "EXTENSION",
        targetChannel: `PJSIP/${agent.handoffExtension.number}`,
        targetLabel: agent.handoffExtension.number,
      },
    };
  }

  return { ok: false, reason: "no_target_configured" };
}

async function resolveCallerChannel(ami: AmiClient, callUuid: string): Promise<{ channels: AmiEvent[]; callerChannel: string | null }> {
  // Because the AI leg IS the caller's own channel (AudioSocket() runs on
  // it directly, not a separate leg — see main.py), Uniqueid === callUuid
  // exactly; no dialplan ${CHANNEL} passthrough is needed or wanted (it
  // would be stale after a masquerade). findChannelsToRedirect() in
  // conference-orchestration.ts does NOT apply here — it keys off
  // `PJSIP/<agentExtension>-`, and this caller's channel is a Dinstar trunk
  // or internal PJSIP channel with no such prefix relationship to the AI.
  const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
  const channels = events.filter((e) => e.Event === "CoreShowChannel");
  const callerChannel = channels.find((e) => e.Uniqueid === callUuid)?.Channel ?? null;
  return { channels, callerChannel };
}

function countActiveGsmChannels(channels: AmiEvent[]): number {
  return channels.filter((e) => (e.Channel ?? "").startsWith(GSM_TRUNK_PREFIX)).length;
}

/** Only meaningful for a NUMBER target - an EXTENSION target dials no
 * outside line at all, so there is nothing for checkEscalationDial() (DNC +
 * allowedDestinations) to evaluate. See that function's own module comment
 * in src/lib/ai/compliance.ts for why this is a SEPARATE gate from
 * checkOutbound()/outboundEnabled, not a reuse of it. */
async function checkCompliance(agentId: string, target: ResolvedTarget): Promise<UnavailableReason | null> {
  if (target.targetKind !== "NUMBER") return null;
  const decision = await checkEscalationDial({
    tenantId: target.tenantId,
    agentId,
    destinationE164: target.targetLabel,
  });
  return decision.allowed ? null : "compliance_denied";
}

async function hangupChannelBestEffort(ami: AmiClient, channel: string | null | undefined): Promise<void> {
  if (!channel) return;
  try {
    await ami.send({ Action: "Hangup", Channel: channel });
  } catch {
    // Best-effort only — pbx_configs/extensions.conf's [ai-conference-leg]
    // sets TIMEOUT(absolute)=3600 as the real backstop against an orphaned
    // leg if this also fails.
  }
}

/** Called only when the ConfbridgeJoin gate times out (see handleMerge) —
 * we don't have the stray Local channel's exact name from a join event
 * that never arrived, so find it by its known prefix instead. */
async function reapStrayAiLeg(ami: AmiClient): Promise<void> {
  try {
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    const stray = events.find(
      (e) => e.Event === "CoreShowChannel" && (e.Channel ?? "").startsWith(AI_CONFERENCE_LEG_CHANNEL_PREFIX)
    );
    await hangupChannelBestEffort(ami, stray?.Channel);
  } catch {
    // Best-effort only, same TIMEOUT(absolute) backstop as above.
  }
}

interface CheckResult {
  available: boolean;
  reason?: UnavailableReason;
  targetKind?: "NUMBER" | "EXTENSION";
  targetLabel?: string;
}

async function handleCheck(agentId: string, callUuid: string): Promise<CheckResult> {
  const resolved = await resolveEscalationTarget(agentId);
  if (!resolved.ok) return { available: false, reason: resolved.reason };

  const ami = getAmiClient();
  await ami.connect();
  const { channels, callerChannel } = await resolveCallerChannel(ami, callUuid);
  if (!callerChannel) return { available: false, reason: "call_not_found" };

  if (resolved.target.targetKind === "NUMBER" && countActiveGsmChannels(channels) >= GSM_TRUNK_CAPACITY) {
    return { available: false, reason: "gsm_capacity" };
  }

  const complianceReason = await checkCompliance(agentId, resolved.target);
  if (complianceReason) return { available: false, reason: complianceReason };

  return { available: true, targetKind: resolved.target.targetKind, targetLabel: resolved.target.targetLabel };
}

interface MergeResult {
  merged: boolean;
  reason?: UnavailableReason;
  confId?: string;
  targetKind?: "NUMBER" | "EXTENSION";
  targetLabel?: string;
  humanAnswered?: boolean;
}

async function handleMerge(agentId: string, callUuid: string): Promise<MergeResult> {
  const resolved = await resolveEscalationTarget(agentId);
  if (!resolved.ok) return { merged: false, reason: resolved.reason };
  const { target } = resolved;

  const ami = getAmiClient();
  await ami.connect();

  const { channels, callerChannel } = await resolveCallerChannel(ami, callUuid);
  if (!callerChannel) return { merged: false, reason: "call_not_found" };

  if (target.targetKind === "NUMBER" && countActiveGsmChannels(channels) >= GSM_TRUNK_CAPACITY) {
    return { merged: false, reason: "gsm_capacity" };
  }

  const complianceReason = await checkCompliance(agentId, target);
  if (complianceReason) return { merged: false, reason: complianceReason };

  // 7-digit room id, dedicated `9XXXXXX` space so it can never collide with
  // api/calls/conference|manager-merge's 4-digit [conference] room ids.
  const confId = `9${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
  const aiLegUuid = randomUUID();

  // GOVERNING INVARIANT: the caller is only ever moved (the Redirect below)
  // once the AI's own leg is PROVEN to already be in the room. Everything
  // above this point is safe to fail — the caller has not been touched.
  //
  // Originate the AI's leg FIRST, never the caller. Async:true is
  // mandatory: ami-client.ts's send() has a hardcoded 5s response timeout,
  // and Originate answer/no-answer here is instead observed via the
  // ConfbridgeJoin wait below. Variable: is a SINGLE AMI header (frameAction
  // takes Record<string,string> — repeated keys are structurally
  // impossible) — comma-separated, so none of these values may ever
  // contain a comma; a UUID, cuid tenantId, and extension number never do.
  try {
    await ami.send({
      Action: "Originate",
      Channel: `Local/ai@${AI_CONFERENCE_LEG_CONTEXT}/n`,
      Context: AI_CONFERENCE_CONTEXT,
      Exten: confId,
      Priority: "1",
      Async: "true",
      // Pins the Local leg to AudioSocket's native 8kHz signed-linear,
      // avoiding a pointless transcode and a frame-size mismatch against
      // confbridge.conf's mixing_interval=20.
      Codecs: "slin",
      CallerID: "AI Assistant <ai>",
      Variable: `AI_CONF_UUID=${aiLegUuid},AI_RESUME_OF=${callUuid},AI_TENANT_ID=${target.tenantId},AI_EXTENSION_NUMBER=${target.aiExtensionNumber}`,
    });
  } catch {
    return { merged: false, reason: "ai_leg_originate_failed" };
  }

  const joined = await ami.waitForEvent(
    (e) => e.Event === "ConfbridgeJoin" && e.Conference === confId && (e.Channel ?? "").startsWith(AI_CONFERENCE_LEG_CHANNEL_PREFIX),
    8000
  );
  if (!joined) {
    // Caller has NOT been touched — still talking to the AI on its
    // original leg. Best-effort cleanup of the stray Local channel;
    // TIMEOUT(absolute)=3600 in the dialplan is the real backstop.
    await reapStrayAiLeg(ami);
    return { merged: false, reason: "ai_leg_join_timeout" };
  }
  const aiLegChannel = joined.Channel;

  try {
    await ami.send({
      Action: "Redirect",
      Channel: callerChannel,
      Context: AI_CONFERENCE_CONTEXT,
      Exten: confId,
      Priority: "1",
    });
  } catch {
    // The caller hung up (or their channel otherwise vanished) between the
    // gate above and this Redirect — the AI leg would otherwise be an
    // orphan alone in the room forever, since ConfBridge's end_marked
    // mechanism (confbridge.conf) only fires once a MARKED user leaves, and
    // none ever joined. We have the exact channel name from the join event,
    // so clean it up directly rather than falling back to reapStrayAiLeg's
    // prefix scan.
    await hangupChannelBestEffort(ami, aiLegChannel);
    return { merged: false, reason: "caller_hung_up" };
  }

  // Originate the human. Deliberately sequential (after the Redirect
  // above), not fired concurrently with it as the original plan sketch
  // considered — issuing both at once removes the guarantee that a caller
  // who vanished mid-Redirect never gets a human Originated into an
  // AI-only room with no caller. The ~1s of extra ring time this costs is a
  // better trade than that race.
  try {
    await ami.send({
      Action: "Originate",
      Channel: target.targetChannel,
      Context: AI_CONFERENCE_CONTEXT,
      Exten: confId,
      Priority: "1",
      Async: "true",
      CallerID: `AI Escalation <${target.aiExtensionNumber}>`,
    });
  } catch {
    // Caller + AI are already merged and continue talking in the room —
    // not a hard failure of the merge itself, just of reaching the human.
    // Fall through to the same "did they answer" observation below, which
    // will simply time out and report humanAnswered: false.
  }

  // The human Originate targets a dialplan Context/Exten directly (never a
  // Dial() call), so there is no DialEnd event to watch — this is why
  // src/lib/escalation.ts's watchEscalationOutcome() (keyed on a
  // `PJSIP/<ext>-` DialEnd, which only Dial() emits) does NOT apply here,
  // despite looking like the obvious reuse. This mirrors
  // api/calls/manager-merge/route.ts's own OriginateResponse/Exten
  // observation instead, which targets the same Context/Exten shape this
  // route does.
  const outcome = await ami.waitForEvent((e) => e.Event === "OriginateResponse" && e.Exten === confId, 25_000);
  const humanAnswered = outcome?.Reason === "4" || outcome?.Response === "Success";

  return { merged: true, confId, targetKind: target.targetKind, targetLabel: target.targetLabel, humanAnswered };
}

interface CallbackResult {
  created: boolean;
  reason?: CallbackFailureReason;
  taskId?: string;
}

/** Who a callback task lands on: the escalation target's own linked User
 * when it's an EXTENSION target (they're the colleague the caller was
 * being connected to in the first place), else any tenant admin.
 * ContactTask.assigneeId is a required FK (schema.prisma) — this must
 * never return null to a real tenant with at least one admin user, which
 * every provisioned tenant has by construction. */
async function resolveCallbackAssignee(db: TenantClient, agentId: string): Promise<string | null> {
  const agent = await unsafeGlobalDb.aiAgent.findUnique({
    where: { id: agentId },
    select: { handoffExtension: { select: { user: { select: { id: true } } } } },
  });
  if (agent?.handoffExtension?.user?.id) return agent.handoffExtension.user.id;
  const admin = await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  return admin?.id ?? null;
}

/** Creates a CRM callback task for the caller currently on this AudioSocket
 * connection - called when the caller declines to keep waiting after a
 * blocked/failed escalation attempt (EscalationController's own
 * "offer_wait_or_callback" step, ai-voice-agent/escalation.py). Reuses
 * src/lib/crm/tasks-data.ts's createTask() as-is, which already writes the
 * matching unified-timeline Activity row - no new CRM plumbing needed,
 * only the find-or-create Contact step ahead of it, since an unknown GSM
 * caller has no Contact row today. */
async function handleCallback(agentId: string, callUuid: string, reason: string | undefined): Promise<CallbackResult> {
  const agent = await unsafeGlobalDb.aiAgent.findUnique({
    where: { id: agentId },
    select: { tenantId: true },
  });
  if (!agent) return { created: false, reason: "agent_not_found" };

  const ami = getAmiClient();
  await ami.connect();
  const { channels, callerChannel } = await resolveCallerChannel(ami, callUuid);
  if (!callerChannel) return { created: false, reason: "call_not_found" };

  // ASSUMPTION, same confidence tier as every other AMI event-field mapping
  // in this codebase (see conference-orchestration.ts's own BridgeId
  // caveat): CoreShowChannel's caller-id field is named CallerIDNum,
  // reconstructed from Asterisk 20 documentation, not observed live.
  const callerIdRaw = channels.find((e) => e.Uniqueid === callUuid)?.CallerIDNum;
  if (!callerIdRaw) return { created: false, reason: "caller_number_unknown" };
  const callerNumber = normalizeToE164(callerIdRaw) ?? callerIdRaw;

  const db = tenantDb(agent.tenantId);

  // No `tenantId` in the create literal — TenantClient force-injects it,
  // same convention as src/lib/ai/sessions.ts / crm/tasks-data.ts's own
  // identical comment on this pattern.
  const contact = await db.contact.upsert({
    where: { tenantId_numberE164: { tenantId: agent.tenantId, numberE164: callerNumber } },
    update: {},
    create: { numberE164: callerNumber } as unknown as Prisma.ContactUncheckedCreateInput,
    select: { id: true },
  });

  const assigneeId = await resolveCallbackAssignee(db, agentId);
  if (!assigneeId) return { created: false, reason: "no_assignee_available" };

  // AiAgent has no User row to act as the Activity's actorId (same problem
  // checkOutbound()'s auditDecision() and checkEscalationDial() already
  // solve) - reuse the identical per-tenant system-actor pattern.
  const systemActorId = await ensureSystemActorId(unsafeGlobalDb, agent.tenantId);

  const task = await createTask(
    db,
    {
      title: "Callback requested — AI escalation",
      contactId: contact.id,
      assigneeId,
      dealId: null,
      dueAt: null,
      description: reason ? `Caller asked for a callback. AI's note: ${reason}` : "Caller asked for a callback.",
    },
    systemActorId
  );

  return { created: true, taskId: task.id };
}

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  if (!isAuthorizedInternalAiRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
  }

  try {
    if (parsed.data.action === "check") {
      const result = await handleCheck(parsed.data.agentId, parsed.data.callUuid);
      return NextResponse.json(result);
    }
    if (parsed.data.action === "callback") {
      const result = await handleCallback(parsed.data.agentId, parsed.data.callUuid, parsed.data.reason);
      return NextResponse.json(result);
    }
    const result = await handleMerge(parsed.data.agentId, parsed.data.callUuid);
    return NextResponse.json(result);
  } catch {
    // Never echo raw AMI errors (host/port on a connection failure) to a
    // machine-to-machine caller either — same rule the agent-facing
    // conference/manager-merge routes already follow.
    return NextResponse.json({ error: "Escalation orchestration failed." }, { status: 502 });
  }
});
