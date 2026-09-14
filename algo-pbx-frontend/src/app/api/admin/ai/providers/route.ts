import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { encryptSetting } from "@/lib/settings/crypto";
import { getProviderAdapter } from "@/lib/ai/providers";
import type { AiProviderKind } from "@/lib/ai/types";
import { unsafeGlobalDb } from "@/lib/db";
import { planHasFeature } from "@/lib/platform/plan-catalog";

export const dynamic = "force-dynamic";

// POST/GET /api/admin/ai/providers — manage per-tenant AiProviderCredential
// rows (contracts.md "Provider adapter interface", W3). The raw apiKey is
// validated by actually calling the vendor's listModels() before anything
// is persisted, and is never echoed back in any response — only
// apiKeyCipher is stored, and that field is never selected here.
const PROVIDER_KINDS: AiProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "deepgram",
  "elevenlabs",
  "cartesia",
  "sarvam",
  "assemblyai",
  "azure",
  "ultravox",
  "openai_compatible",
  "retell",
  "vapi",
];

const CreateSchema = z.object({
  provider: z.enum(PROVIDER_KINDS as [AiProviderKind, ...AiProviderKind[]]),
  label: z.string().min(1).max(100),
  apiKey: z.string().min(1),
  region: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
});

const CREDENTIAL_SELECT = {
  id: true,
  provider: true,
  label: true,
  region: true,
  baseUrl: true,
  cachedModels: true,
  fetchedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Post-verification finding (2026-09-14): this route accepts an
// admin-supplied baseUrl that server-side fetch() uses (openai_compatible
// adapter), which is only safe to expose to tenants on a plan that's
// actually supposed to have this feature — same "re-check even though the
// UI already hides it" reasoning src/app/api/admin/ai/agents/route.ts
// documents for itself. Without this, a tenant on any plan could reach the
// SSRF-guarded-but-still-sensitive provider-key/baseUrl machinery.
async function requireAiAgentsPlan(tenantId: string): Promise<NextResponse | null> {
  const tenant = await unsafeGlobalDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  if (!planHasFeature(tenant?.plan ?? "standard", "aiAgents")) {
    return NextResponse.json({ error: "AI agents are not included on this plan." }, { status: 403 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const planError = await requireAiAgentsPlan(session.user.tenantId);
  if (planError) return planError;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { provider, label, apiKey, region, baseUrl } = parsed.data;

  const adapter = getProviderAdapter(provider);
  let models;
  try {
    models = await adapter.listModels({ apiKey, region: region ?? null, baseUrl: baseUrl ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to validate API key with the provider";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const apiKeyCipher = encryptSetting(apiKey);

  let credential;
  try {
    credential = await db.aiProviderCredential.create({
      data: {
        provider,
        label,
        apiKeyCipher,
        region: region ?? null,
        baseUrl: baseUrl ?? null,
        cachedModels: models as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
      } as unknown as Prisma.AiProviderCredentialUncheckedCreateInput,
      select: CREDENTIAL_SELECT,
    });
  } catch (err) {
    // Most likely the @@unique([tenantId, provider, label]) constraint.
    const message = err instanceof Error ? err.message : "Failed to save provider credential";
    return NextResponse.json({ error: message }, { status: 409 });
  }

  return NextResponse.json({ credential }, { status: 201 });
}

export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const credentials = await db.aiProviderCredential.findMany({
    orderBy: { createdAt: "desc" },
    select: CREDENTIAL_SELECT,
  });
  return NextResponse.json({ credentials });
}
