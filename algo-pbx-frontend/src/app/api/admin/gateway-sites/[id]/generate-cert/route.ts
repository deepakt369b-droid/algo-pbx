import { NextRequest, NextResponse } from "next/server";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// POST /api/admin/gateway-sites/[id]/generate-cert — the caller-side half
// of the OpenVPN PKI bridge Node B built (pbx_configs/openvpn/bridge-watch.sh).
// This route holds no Docker socket and never touches PKI material
// directly: it drops an empty request-marker file into a shared bind
// mount and polls for the bridge's response, exactly per that script's
// documented contract. ADMIN-only — this provisions a real client
// identity for production telephony infrastructure.
const REQUESTS_DIR = process.env.OPENVPN_REQUESTS_DIR || "/app/openvpn-requests";
const CLIENTS_DIR = process.env.OPENVPN_CLIENTS_DIR || "/app/openvpn-clients";

// Matches bridge-watch.sh's own SAFE_NAME_RE exactly — defense in depth,
// re-validated here rather than trusting that GatewaySite.name was
// checked correctly when the row was created. Never interpolated into a
// filesystem path without this check passing first.
const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const POLL_INTERVAL_MS = 500;
// A local file-drop bridge polling every 2s (bridge-watch.sh's own
// interval) should respond within a few seconds for a fresh easyrsa
// issuance; 20s gives real headroom without leaving an admin's request
// hanging indefinitely if the bridge container is down.
const POLL_TIMEOUT_MS = 20_000;

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const site = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  if (!SAFE_NAME_RE.test(site.name)) {
    // Should be impossible if the create route validated correctly, but
    // this is exactly the class of check bridge-watch.sh's own header
    // says it does NOT trust from upstream — mirror that here too.
    return NextResponse.json({ error: `Site name "${site.name}" is not safe to use as a certificate CN.` }, { status: 400 });
  }

  const doneFile = path.join(CLIENTS_DIR, `${site.name}.done`);
  const errorFile = path.join(CLIENTS_DIR, `${site.name}.error`);

  // Clear any stale sentinel from a prior failed attempt before issuing a
  // fresh request — otherwise a leftover .error from a previous run could
  // be misread as this request's own result.
  await unlink(errorFile).catch(() => undefined);
  await unlink(doneFile).catch(() => undefined);

  await writeFile(path.join(REQUESTS_DIR, `${site.name}.generate`), "", "utf8");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await fileExists(doneFile)) {
      await db.auditLog.create({
        data: { action: "site.cert_generated", actorId: session.user.id, targetId: site.id, metadata: { siteName: site.name } } as unknown as Prisma.AuditLogUncheckedCreateInput,
      });
      return NextResponse.json({ ok: true });
    }
    if (await fileExists(errorFile)) {
      const message = await readFile(errorFile, "utf8").catch(() => "Certificate generation failed.");
      await db.auditLog.create({
        data: { action: "site.cert_generated", actorId: session.user.id, targetId: site.id, metadata: { siteName: site.name, error: message.trim() } } as unknown as Prisma.AuditLogUncheckedCreateInput,
      });
      return NextResponse.json({ ok: false, error: message.trim() }, { status: 502 });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return NextResponse.json(
    { ok: false, error: "Timed out waiting for the OpenVPN bridge to respond — check that the openvpn-bridge container is running." },
    { status: 504 }
  );
}
