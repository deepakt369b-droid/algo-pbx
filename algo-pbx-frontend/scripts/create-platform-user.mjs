#!/usr/bin/env node
// Bootstrap path for PlatformUser accounts — the platform-plane equivalent
// of scripts/create-admin-user.mjs. There is deliberately no web route that
// CREATES a PlatformUser: an unauthenticated "make me a platform account"
// HTTP endpoint would itself be a way to mint privileged access, the same
// /api/setup pattern this repo's tenant plane already forbids for the
// same reason. So this runs only here, over a shell someone already has to
// have privileged access to reach (SSH to the VPS).
//
// TOTP enrollment does NOT happen in this script — mandatory 2FA
// (src/lib/platform-auth.ts's authorize()) still hard-blocks any action
// beyond the /platform/setup screen for an account with no confirmed
// secret, but the enrollment itself (scan QR / enter secret, confirm a
// live code) happens in-browser at first login, where the operator
// actually has their authenticator app open. This script's only job is to
// mint the account and a one-time password.
//
// Usage:
//   node scripts/create-platform-user.mjs --email <email> --role <role> [--name <name>] [--reason <text>]
//     role: PLATFORM_OWNER | PLATFORM_SUPPORT
//     name: defaults to the email's local part
//     reason: audit-log reason for this bootstrap (default below)
//
//   Generates a strong random one-time password, prints it to the
//   terminal EXACTLY ONCE (never logged, never written to any file), and
//   marks the account mustChangePassword + un-enrolls any existing TOTP
//   secret. First login at /platform forces a password change and TOTP
//   enrollment before the owner console is reachable.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const db = new PrismaClient();

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i += 1;
  }
  return args;
}

// 24 random bytes -> base64url, ~32 chars, no ambiguous padding/slashes —
// safe to read aloud or paste into a password manager, well above any
// brute-force concern for a one-time credential that's replaced on first use.
function generateOneTimePassword() {
  return crypto.randomBytes(24).toString("base64url");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email;
  const role = args.role;
  const name = args.name ?? (email ? email.split("@")[0] : undefined);
  const reason = args.reason ?? "platform user bootstrap via script";

  if (!email || !role) {
    return fail(
      "Usage: node scripts/create-platform-user.mjs --email <email> --role <PLATFORM_OWNER|PLATFORM_SUPPORT> [--name <name>] [--reason <text>]"
    );
  }
  if (!["PLATFORM_OWNER", "PLATFORM_SUPPORT"].includes(role)) {
    return fail("--role must be one of PLATFORM_OWNER, PLATFORM_SUPPORT");
  }

  const oneTimePassword = generateOneTimePassword();
  const passwordHash = await bcrypt.hash(oneTimePassword, 12);

  // Re-running this against an existing email (password reset path) always
  // clears any prior TOTP enrollment too — a stale, possibly-exposed secret
  // must not keep working silently after a password reset forces the
  // account back through setup.
  const user = await db.platformUser.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      name,
      role,
      totpSecret: null,
      totpConfirmedAt: null,
      mustChangePassword: true,
    },
    update: {
      passwordHash,
      name,
      role,
      totpSecret: null,
      totpConfirmedAt: null,
      mustChangePassword: true,
    },
  });

  await db.platformAuditLog.create({
    data: {
      action: "platform.user.create",
      // No platformUserId of the actor — this action has no authenticated
      // platform session behind it, it ran from a privileged shell. The
      // script itself is the actor; recorded in metadata rather than
      // borrowing the newly-created row's id (which would misrepresent the
      // new account as having acted on its own behalf before it has ever
      // logged in).
      reason,
      metadata: {
        actor: "script:scripts/create-platform-user.mjs",
        targetEmail: user.email,
        targetRole: user.role,
        targetPlatformUserId: user.id,
      },
    },
  });

  console.log(`Upserted platform user ${user.email} (${user.role}), id=${user.id}`);
  console.log("");
  console.log("ONE-TIME PASSWORD (shown once, never stored or logged anywhere):");
  console.log(`  ${oneTimePassword}`);
  console.log("");
  console.log("Sign in at /platform with this email + password. TOTP has no code yet —");
  console.log("leave that field blank on this first login. You will be forced through a");
  console.log("password change and TOTP enrollment (via QR/manual entry in-browser) before");
  console.log("reaching the owner console.");
}

await main();
await db.$disconnect();
