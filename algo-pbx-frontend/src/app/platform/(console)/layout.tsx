import { redirect } from "next/navigation";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { platformSignOut } from "@/lib/platform-auth";
import { PlatformShell } from "@/components/platform-shell/platform-shell";

// Guarded layout for the whole owner console.
//
// The `(console)` route group exists precisely so this layout does NOT wrap
// /platform/login or /platform/setup. Both are siblings outside the group: a
// layout that demanded a completed setup would make the setup screen
// unreachable by anyone who needs it, and the login page unreachable by
// everyone.
//
// This is defence in depth, not the security boundary. middleware.ts's
// /platform branch already redirects an unauthenticated page navigation, and
// every route under /api/platform/** guards itself with
// requirePlatformSession() — the middleware matcher excludes /api entirely,
// so API routes never rely on anything here. What this adds is a single place
// that cannot be forgotten when a new console page is added, and the same
// single-point-of-failure reasoning admin/layout.tsx records for itself:
// middleware silently stops loading if src/app is ever flattened to app/,
// with no build error.
//
// It also enforces the plane's own precondition — a PlatformUser with no
// confirmed TOTP, or one still holding a script-issued one-time password,
// gets bounced to /platform/setup rather than into the console.

export default async function PlatformConsoleLayout({ children }: { children: React.ReactNode }) {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) {
    redirect("/platform/login");
  }
  if (!guard.totpConfirmedAt || guard.mustChangePassword) {
    redirect("/platform/setup");
  }

  async function signOutAction() {
    "use server";
    await platformSignOut({ redirectTo: "/platform/login" });
  }

  return (
    <PlatformShell
      userEmail={guard.session.user.email}
      role={guard.session.user.role}
      signOutAction={signOutAction}
    >
      {children}
    </PlatformShell>
  );
}
