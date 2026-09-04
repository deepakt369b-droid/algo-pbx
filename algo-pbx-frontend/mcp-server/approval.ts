import { createHash, randomBytes } from "node:crypto";
// mcp-server is an operator/infra tool with no session or tenant context of
// its own (see db-tools.ts's header for the fuller discussion). McpApproval
// is a platform-global model (src/lib/tenancy/scope-rules.ts's
// PLATFORM_GLOBAL_MODELS) — no tenantId column exists on it at all — so
// unsafeGlobalDb is the correct, not just expedient, client for it.
// recordAudit() below additionally resolves a tenantId by hand (off the
// minting admin's own User row) before writing to the tenant-scoped
// AuditLog table, same pattern as src/lib/two-factor.ts's resolveTenantId().
import { unsafeGlobalDb } from "../src/lib/db";

// Every write tool this server exposes requires a valid, unexpired,
// unconsumed approval token minted by an admin from the web app
// (POST /api/admin/mcp-approvals — src/app/app/api/admin/mcp-approvals).
// This module is the consuming half: it hashes the token the caller
// supplied, looks up the McpApproval row, checks expiry/consumption/scope,
// and — only on success — marks it consumed and returns. The mint route
// never stores the raw token, only its SHA-256 hash, matching Invite's
// one-time-disclosure pattern elsewhere in this codebase.
//
// TWO-STEP FLOW (documented here once, referenced from every write tool's
// description string so an LLM client understands it without guessing):
//   1. Call the write tool WITHOUT approvalToken (or the tool's paired
//      "*_preview" variant, where one exists) to see exactly what would
//      change / what command would run. Nothing is applied.
//   2. An admin mints a token scoped to that specific action
//      (POST /api/admin/mcp-approvals { scope }) and hands it to the
//      operator running this server.
//   3. Call the write tool again WITH approvalToken. Only then does the
//      write happen — and the token is consumed immediately afterward, so
//      it cannot be replayed.

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export interface ConsumeResult {
  ok: boolean;
  error?: string;
  /** The admin who minted this token — carried through so the caller can
   * attribute the resulting AuditLog row to a real person, not the tool. */
  mintedByAdminId?: string;
}

/**
 * Validate and consume a token for exactly one `scope`. A row minted with
 * scope "*" satisfies any requested scope — see the mint route for why
 * that requires an explicit admin opt-in rather than being the default.
 */
export async function consumeApproval(token: string | undefined, scope: string): Promise<ConsumeResult> {
  if (!token) return { ok: false, error: "This action requires an approvalToken. See the tool description for the preview -> mint -> execute flow." };

  const tokenHash = hashToken(token);
  const approval = await unsafeGlobalDb.mcpApproval.findUnique({ where: { tokenHash } });

  if (!approval) return { ok: false, error: "Unknown approval token." };
  if (approval.consumedAt) return { ok: false, error: "This approval token has already been used." };
  if (approval.expiresAt.getTime() <= Date.now()) return { ok: false, error: "This approval token has expired." };
  if (approval.scope !== "*" && approval.scope !== scope) {
    return { ok: false, error: `This approval token is scoped to "${approval.scope}", not "${scope}".` };
  }

  // Consume BEFORE the caller performs the actual write — a single-use
  // token must not be replayable even if the caller's write fails partway
  // through; re-minting is cheap and correct, replay is not.
  await unsafeGlobalDb.mcpApproval.update({ where: { id: approval.id }, data: { consumedAt: new Date() } });

  return { ok: true, mintedByAdminId: approval.mintedByAdminId };
}

export async function recordAudit(action: string, mintedByAdminId: string | undefined, metadata: unknown): Promise<void> {
  // mcp-server has no session of its own — the "actor" for AuditLog
  // purposes is whichever admin minted the approval token that authorized
  // this write, recovered from the McpApproval row before it's consumed.
  if (!mintedByAdminId) return;
  const admin = await unsafeGlobalDb.user.findUnique({ where: { id: mintedByAdminId }, select: { tenantId: true } });
  if (!admin) return;
  await unsafeGlobalDb.auditLog.create({
    data: { action, actorId: mintedByAdminId, tenantId: admin.tenantId, metadata: metadata as object },
  }).catch(() => undefined);
}
