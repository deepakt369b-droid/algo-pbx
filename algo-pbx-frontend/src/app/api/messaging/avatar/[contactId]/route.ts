import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { resolveContactAvatarUrl } from "@/lib/messaging/history-sync";

export const dynamic = "force-dynamic";

// A 1x1 transparent PNG — returned (200, long cache) when a contact has no
// WhatsApp picture, so the browser <img> just falls through to the CSS
// initials fallback instead of firing an onError every render.
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

// GET /api/messaging/avatar/[contactId] — proxies a contact's WhatsApp
// profile picture. The raw pps.whatsapp.net URL is cross-origin (blocked by
// our img-src CSP) and expires, so it is never handed to the browser;
// history-sync.ts refreshes it from OpenWA on a 6h TTL.
export async function GET(_request: NextRequest, { params }: { params: { contactId: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const url = await resolveContactAvatarUrl(guard.db, params.contactId).catch(() => null);
  const blank = (maxAge: number) =>
    new NextResponse(new Uint8Array(BLANK_PNG), {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": `private, max-age=${maxAge}` },
    });

  if (!url) return blank(3600);

  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    const bytes = Buffer.from(await res.arrayBuffer());
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") || "image/jpeg",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=21600",
      },
    });
  } catch {
    return blank(600);
  }
}
