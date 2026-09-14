import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { decryptSetting } from "@/lib/settings/crypto";
import { getProviderAdapter } from "@/lib/ai/providers";
import type { AiProviderKind } from "@/lib/ai/types";

export const dynamic = "force-dynamic";

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

// POST /api/admin/ai/providers/[id]/refresh — re-run listModels() with the
// already-stored (decrypted) key and refresh cachedModels/fetchedAt.
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const existing = await db.aiProviderCredential.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let apiKey: string;
  try {
    apiKey = decryptSetting(existing.apiKeyCipher);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to decrypt stored API key";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const adapter = getProviderAdapter(existing.provider as AiProviderKind);
  let models;
  try {
    models = await adapter.listModels({ apiKey, region: existing.region, baseUrl: existing.baseUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh models from the provider";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const credential = await db.aiProviderCredential.update({
    where: { id: params.id },
    data: {
      cachedModels: models as unknown as Prisma.InputJsonValue,
      fetchedAt: new Date(),
    },
    select: CREDENTIAL_SELECT,
  });

  return NextResponse.json({ credential });
}
