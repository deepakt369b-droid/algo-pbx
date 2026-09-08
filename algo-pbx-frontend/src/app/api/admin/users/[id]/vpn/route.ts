import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { encryptSetting } from "@/lib/settings/crypto";
import { subnetCidr } from "@/lib/platform/subnet";
import { nextUserVpnIp } from "@/lib/connectivity/user-vpn-ip";
import { buildUserVpnConfig, supportsGeneratedConfig } from "@/lib/connectivity/user-vpn-config";
import { generateWireguardKeypair } from "@/lib/connectivity/wireguard-keypair";

export const dynamic = "force-dynamic";

// GET/POST/DELETE /api/admin/users/[id]/vpn - per-user VPN profile
// management (owner-page enchanted-sphinx plan, W3: each tenant user gets
// their own Tailscale/Headscale/OpenVPN/WireGuard setup page, administered
// only in the tenant admin console, never the agent console).
//
// requireAdminSession() - not the nav - is what keeps this out of the
// agent console: an AGENT session gets a 403 here regardless of what any
// page renders.
//
// The generated config is returned ONCE, on POST, and never re-served by
// GET - same one-time-disclosure discipline as Extension.sipSecret and
// ApiKey (see src/app/api/admin/api-keys/route.ts). GET returns metadata
// plus a hasConfig flag so the UI can offer "regenerate" without ever
// reading the stored ciphertext back out over the wire.

const PostSchema = z.object({
  transport: z.enum(["WIREGUARD", "HEADSCALE", "TAILSCALE", "OPENVPN"]).default("WIREGUARD"),
  label: z.string().min(1).max(64).optional(),
  tunnelIp: z.string().ip({ version: "v4" }).optional(),
  // Only meaningful for a generated config (WIREGUARD/HEADSCALE) - the real
  // WireGuard server's own public key + reachable address. This app has no
  // per-tenant WireGuard server of its own to provision (a separate,
  // out-of-scope infra concern, same category as the OpenVPN CA's manual
  // signing step) - an operator supplies these once and later profiles in
  // the same tenant reuse the most recent values on file.
  serverPublicKey: z.string().min(1).max(200).optional(),
  serverEndpoint: z.string().min(1).max(200).optional(),
});

async function loadTenantTakenIps(db: import("@/lib/db-tenant").TenantClient): Promise<string[]> {
  const rows = await db.userVpnProfile.findMany({
    where: { revokedAt: null, tunnelIp: { not: null } },
    select: { tunnelIp: true },
  });
  return rows.map((r) => r.tunnelIp).filter((ip): ip is string => Boolean(ip));
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;
  const user = await db.user.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const profile = await db.userVpnProfile.findUnique({ where: { userId: params.id } });
  if (!profile) return NextResponse.json({ profile: null });

  return NextResponse.json({
    profile: {
      id: profile.id,
      transport: profile.transport,
      label: profile.label,
      tunnelIp: profile.tunnelIp,
      publicKey: profile.publicKey,
      status: profile.status,
      lastHandshakeAt: profile.lastHandshakeAt,
      lastReachableAt: profile.lastReachableAt,
      revokedAt: profile.revokedAt,
      hasConfig: Boolean(profile.configEncrypted) && !profile.revokedAt,
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  const user = await db.user.findUnique({
    where: { id: params.id },
    select: { id: true, email: true, name: true, tenantId: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const tenant = await db.tenant.findUnique({
    where: { id: user.tenantId },
    select: { tunnelSubnetIndex: true },
  });
  if (!tenant || tenant.tunnelSubnetIndex === null) {
    return NextResponse.json(
      { error: "This tenant has no allocated tunnel subnet yet - finish provisioning before creating VPN profiles." },
      { status: 400 }
    );
  }

  if (!supportsGeneratedConfig(body.transport)) {
    // TAILSCALE / OPENVPN - no generated config; the profile row still
    // tracks that the transport is assigned so the UI has something to
    // show, but there is nothing to encrypt or return (see
    // supportsGeneratedConfig()'s doc comment for why).
    const profile = await db.userVpnProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        transport: body.transport,
        label: body.label ?? null,
        status: "UNKNOWN",
        createdById: session.user.id,
      } as unknown as Prisma.UserVpnProfileUncheckedCreateInput,
      update: { transport: body.transport, label: body.label ?? null, revokedAt: null },
    });

    await db.auditLog.create({
      data: {
        action: "user_vpn.create_or_rotate",
        actorId: session.user.id,
        targetId: user.id,
        metadata: { transport: body.transport },
      } as unknown as Prisma.AuditLogUncheckedCreateInput,
    });

    return NextResponse.json(
      {
        profile: {
          id: profile.id,
          transport: profile.transport,
          label: profile.label,
          tunnelIp: profile.tunnelIp,
          publicKey: profile.publicKey,
          status: profile.status,
        },
        config: null,
        filename: null,
        note: `${body.transport} has no config this app can generate - set it up through that transport's own flow, then track it here.`,
      },
      { status: 201 }
    );
  }

  let tunnelIp = body.tunnelIp ?? null;
  if (!tunnelIp) {
    const taken = await loadTenantTakenIps(db);
    tunnelIp = nextUserVpnIp(subnetCidr(tenant.tunnelSubnetIndex), taken);
    if (!tunnelIp) {
      return NextResponse.json({ error: "No free tunnel IP left in this tenant's subnet." }, { status: 409 });
    }
  }

  let serverPublicKey = body.serverPublicKey ?? null;
  let serverEndpoint = body.serverEndpoint ?? null;
  if (!serverPublicKey || !serverEndpoint) {
    const existing = await db.userVpnProfile.findFirst({
      where: { tenantId: user.tenantId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    // Server values are not stored as their own columns (only the resulting
    // client config is) - an operator must supply them at least once per
    // tenant; this route cannot silently invent a peer to connect to.
    if (!existing) {
      return NextResponse.json(
        {
          error:
            "No WireGuard server public key/endpoint on file for this tenant yet. Provide serverPublicKey and serverEndpoint for the first profile.",
        },
        { status: 400 }
      );
    }
  }
  if (!serverPublicKey || !serverEndpoint) {
    return NextResponse.json(
      { error: "serverPublicKey and serverEndpoint are required for the first profile in this tenant." },
      { status: 400 }
    );
  }

  const keypair = generateWireguardKeypair();
  const built = buildUserVpnConfig({
    transport: body.transport,
    userLabel: body.label ?? user.name ?? user.email,
    tunnelIp,
    clientPrivateKey: keypair.privateKey,
    serverPublicKey,
    serverEndpoint,
    allowedIps: subnetCidr(tenant.tunnelSubnetIndex),
  });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  const configEncrypted = encryptSetting(built.config);

  const profile = await db.userVpnProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      transport: body.transport,
      label: body.label ?? null,
      tunnelIp,
      publicKey: keypair.publicKey,
      configEncrypted,
      status: "UNKNOWN",
      createdById: session.user.id,
    } as unknown as Prisma.UserVpnProfileUncheckedCreateInput,
    update: {
      transport: body.transport,
      label: body.label ?? null,
      tunnelIp,
      publicKey: keypair.publicKey,
      configEncrypted,
      status: "UNKNOWN",
      revokedAt: null,
    },
  });

  await db.auditLog.create({
    data: {
      action: "user_vpn.create_or_rotate",
      actorId: session.user.id,
      targetId: user.id,
      metadata: { transport: body.transport, tunnelIp },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json(
    {
      profile: {
        id: profile.id,
        transport: profile.transport,
        label: profile.label,
        tunnelIp: profile.tunnelIp,
        publicKey: profile.publicKey,
        status: profile.status,
      },
      config: built.config,
      filename: built.filename,
    },
    { status: 201 }
  );
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;
    const profile = await db.userVpnProfile.findUnique({ where: { userId: params.id } });
  if (!profile) return NextResponse.json({ error: "No VPN profile for this user." }, { status: 404 });

  const updated = await db.userVpnProfile.update({
    where: { userId: params.id },
    data: { revokedAt: new Date() },
  });

  await db.auditLog.create({
    data: {
      action: "user_vpn.revoke",
      actorId: session.user.id,
      targetId: params.id,
      metadata: { transport: profile.transport },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ profile: { id: updated.id, revokedAt: updated.revokedAt } });
}
