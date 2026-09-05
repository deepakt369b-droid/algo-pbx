import { redirect } from "next/navigation";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { unsafeGlobalDb as db } from "@/lib/db";
import { generateTotpSecret, totpUri } from "@/lib/platform-totp";
import { PlatformSetupForm } from "./setup-form";

// First-login screen for an account minted by
// scripts/create-platform-user.mjs: forces (1) a password change off the
// script's one-time password, then (2) TOTP enrollment, before /platform's
// owner console becomes reachable — requirePlatformSession() (the guard
// every OTHER platform route uses) refuses a session in either state,
// redirecting here instead. See platform-auth.ts's authorize() for why a
// session can exist at all before enrollment is complete.
export default async function PlatformSetupPage() {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) {
    redirect("/platform/login");
  }

  const needsPasswordChange = guard.mustChangePassword;
  const needsTotp = !guard.totpConfirmedAt;

  if (!needsPasswordChange && !needsTotp) {
    redirect("/platform");
  }

  let otpauthUri: string | null = null;
  if (needsTotp) {
    // Idempotent: reuse an existing not-yet-confirmed secret across page
    // reloads rather than minting a new one every render, which would
    // invalidate whatever the operator just scanned into their
    // authenticator app.
    const user = await db.platformUser.findUniqueOrThrow({
      where: { id: guard.session.user.id },
      select: { totpSecret: true },
    });
    const secret = user.totpSecret ?? generateTotpSecret();
    if (!user.totpSecret) {
      await db.platformUser.update({
        where: { id: guard.session.user.id },
        data: { totpSecret: secret },
      });
    }
    otpauthUri = totpUri(guard.session.user.email, secret);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <PlatformSetupForm
        needsPasswordChange={needsPasswordChange}
        needsTotp={needsTotp}
        otpauthUri={otpauthUri}
      />
    </main>
  );
}
