import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSession, getQr } from "@/lib/messaging/openwa-client";
import { toWaInstanceStatus } from "@/lib/messaging/openwa-types";
import { ProviderHttpError } from "@/lib/messaging/http";

export const dynamic = "force-dynamic";

// GET /api/admin/whatsapp/instances/[id]/pairing — the poll the admin UI
// hits every ~2s while a card is in a pairing state. This is the route
// that did not exist before: three separate comments elsewhere in this
// codebase claimed "the admin page polls" and none of them did, which is
// the root cause of "the QR is never shown".
//
// Always returns 200 (never 502) when the instance row itself exists — an
// unreachable sidecar is reported via `sidecarReachable: false` in the
// body so the page can render a clear banner instead of hanging or
// blanking out.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const instance = await db.waInstance.findUnique({ where: { id: params.id } });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (instance.provider !== "OPENWA" || !instance.openwaSessionId) {
    return NextResponse.json({
      status: instance.status,
      providerStatus: null,
      qrCode: instance.lastQrCode,
      qrAgeSeconds: instance.lastQrAt ? Math.floor((Date.now() - instance.lastQrAt.getTime()) / 1000) : null,
      pairingCode: instance.pairingCode,
      phoneE164: instance.phoneE164,
      pushName: instance.pushName,
      lastError: instance.lastError,
      sidecarReachable: instance.provider === "OPENWA",
    });
  }

  try {
    const session = await getSession(instance.openwaSessionId);
    const status = toWaInstanceStatus(session.status);

    let qrCode = instance.lastQrCode;
    let lastQrAt = instance.lastQrAt;
    if (session.status === "qr_ready") {
      try {
        const qr = await getQr(instance.openwaSessionId);
        qrCode = qr.qrCode;
        lastQrAt = new Date();
      } catch {
        // Transient — keep the last-known QR rather than blanking the card.
      }
    }

    const updated = await db.waInstance.update({
      where: { id: instance.id },
      data: {
        status,
        providerStatusRaw: session.status,
        phoneE164: session.phone ?? instance.phoneE164,
        pushName: session.pushName ?? instance.pushName,
        lastError: session.lastError ?? null,
        lastStatusAt: new Date(),
        lastQrCode: status === "CONNECTED" ? null : qrCode,
        lastQrAt: status === "CONNECTED" ? null : lastQrAt,
        pairingCode: status === "CONNECTED" ? null : instance.pairingCode,
        pairingCodeAt: status === "CONNECTED" ? null : instance.pairingCodeAt,
        lastConnectedAt: status === "CONNECTED" ? new Date() : instance.lastConnectedAt,
      },
    });

    return NextResponse.json({
      status: updated.status,
      providerStatus: session.status,
      qrCode: updated.lastQrCode,
      qrAgeSeconds: updated.lastQrAt ? Math.floor((Date.now() - updated.lastQrAt.getTime()) / 1000) : null,
      pairingCode: updated.pairingCode,
      phoneE164: updated.phoneE164,
      pushName: updated.pushName,
      lastError: updated.lastError,
      sidecarReachable: true,
    });
  } catch (err) {
    const message = err instanceof ProviderHttpError ? `${err.status}: ${err.body || err.message}` : (err as Error).message;
    await db.waInstance
      .update({ where: { id: instance.id }, data: { lastError: message, lastStatusAt: new Date() } })
      .catch(() => undefined);
    return NextResponse.json({
      status: instance.status,
      providerStatus: null,
      qrCode: instance.lastQrCode,
      qrAgeSeconds: instance.lastQrAt ? Math.floor((Date.now() - instance.lastQrAt.getTime()) / 1000) : null,
      pairingCode: instance.pairingCode,
      phoneE164: instance.phoneE164,
      pushName: instance.pushName,
      lastError: message,
      sidecarReachable: false,
    });
  }
}
