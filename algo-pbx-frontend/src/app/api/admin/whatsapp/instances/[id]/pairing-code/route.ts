import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { requestPairingCode } from "@/lib/messaging/openwa-client";
import { ProviderHttpError } from "@/lib/messaging/http";

export const dynamic = "force-dynamic";

// POST /api/admin/whatsapp/instances/[id]/pairing-code — the friendlier
// alternative to scanning a QR: the admin types the phone number, OpenWA
// returns an 8-character code the agent types into
// WhatsApp > Settings > Linked Devices > Link with phone number instead.
// Digits only, no leading '+', per OpenWA's RequestPairingCodeRequest.
const Schema = z.object({
  phoneNumber: z.string().regex(/^\d{7,15}$/, "Digits only, no leading + or spaces (e.g. 971544887712)"),
});

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const instance = await db.waInstance.findUnique({ where: { id: params.id } });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (instance.provider !== "OPENWA" || !instance.openwaSessionId) {
    return NextResponse.json({ error: "This instance has no active OpenWA session." }, { status: 409 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await requestPairingCode(instance.openwaSessionId, { phoneNumber: parsed.data.phoneNumber });
    const updated = await db.waInstance.update({
      where: { id: instance.id },
      data: { pairingCode: result.pairingCode, pairingCodeAt: new Date(), lastError: null },
    });
    return NextResponse.json({ pairingCode: updated.pairingCode, pairingCodeAt: updated.pairingCodeAt });
  } catch (err) {
    const message = err instanceof ProviderHttpError ? `${err.status}: ${err.body || err.message}` : (err as Error).message;
    await db.waInstance.update({ where: { id: instance.id }, data: { lastError: message } }).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
