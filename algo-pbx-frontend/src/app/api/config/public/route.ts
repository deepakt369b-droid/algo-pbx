import { NextResponse } from "next/server";
import { getSetting } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

// GET /api/config/public — UNAUTHENTICATED, non-secret runtime config
// for client components. Exists because of a real bug this change fixed:
// Next.js inlines NEXT_PUBLIC_* variables into the JS bundle at BUILD
// time, but docker-compose.yml only ever supplied them at container
// RUNTIME — so src/contexts/sip-context.tsx's SIP_DOMAIN/WS_SERVER were
// always undefined in the built image, and every agent's softphone tried
// to connect to a hardcoded "algopbx.local" fallback that doesn't
// resolve. It also meant NEXT_PUBLIC_FIREBASE_* could never be made
// admin-configurable while read the old way — a value typed into
// /admin/settings would be silently ignored in favor of whatever was
// baked into the image at build time.
//
// Every client component that used to read a NEXT_PUBLIC_ var now fetches
// this route on mount instead. Nothing here is secret: it identifies
// endpoints and project ids, never an API key or credential that
// authorizes anything (the actual Firebase secret,
// FIREBASE_SERVICE_ACCOUNT_JSON, stays server-side in
// src/lib/firebase/admin.ts and is never included below).
export async function GET() {
  // SIP_DOMAIN/SIP_WS_SERVER/TURN_SERVER are telephony settings — per the
  // plan, deliberately NOT part of the admin-editable settings registry
  // (their values are duplicated into pbx_configs/manager.conf and the
  // Asterisk/Coturn container commands; editing only this side would
  // silently desync them). Read straight from process.env, which
  // docker-compose.yml supplies at container runtime — reading them HERE
  // (server-side, at request time) rather than inlined into the client
  // bundle is the actual fix for the build-time bug this route exists to
  // close; process.env access on the server always sees the real
  // runtime value, unlike a NEXT_PUBLIC_ reference in client code.
  const sipDomain = process.env.NEXT_PUBLIC_SIP_DOMAIN || "algopbx.local";
  const sipWsServer = process.env.NEXT_PUBLIC_SIP_WS_SERVER || `wss://${sipDomain}:8089/ws`;
  const turnServer = process.env.NEXT_PUBLIC_TURN_SERVER || null;

  const [firebaseApiKey, firebaseAuthDomain, firebaseProjectId, otpChannel] = await Promise.all([
    getSetting("NEXT_PUBLIC_FIREBASE_API_KEY"),
    getSetting("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
    getSetting("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
    getSetting("OTP_CHANNEL"),
  ]);

  return NextResponse.json({
    sipDomain,
    sipWsServer,
    turnServer,
    firebase:
      firebaseApiKey && firebaseAuthDomain && firebaseProjectId
        ? { apiKey: firebaseApiKey, authDomain: firebaseAuthDomain, projectId: firebaseProjectId }
        : null,
    otpChannel: otpChannel || "OPENWA",
  });
}
