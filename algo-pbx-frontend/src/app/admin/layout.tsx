import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { AdminShell } from "@/components/admin-shell/admin-shell";

// Server component: fetches the session, hands a server action + the
// user's email down to the client AdminShell (sidebar/topbar/health
// pill/theme toggle — all need client-side state: usePathname for active
// nav highlight, polling for the health pill, localStorage for the theme).
// Replaces the previous flat 12-link <nav> wrap with a grouped, collapsible
// sidebar (Operations / Messaging / Configuration / Audit) plus a topbar
// carrying the live system-health pill (Phase 7) and theme toggle.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  // Defence in depth. middleware.ts:72 is currently the ONLY thing keeping a
  // plain AGENT off these pages, and this file's own sibling comment in
  // middleware.ts records that the middleware silently stops being loaded if
  // src/app is ever flattened to app/ — with no build error. The API routes
  // under /api/admin all guard themselves via requireAdminSession(), so this
  // is about the page shells, not data. Cheap to add, removes a single point
  // of failure.
  if (session?.user.role !== "ADMIN" && session?.user.role !== "SUPERVISOR") {
    redirect("/agent");
  }

  // userId lets AdminShell notice the session cookie being swapped
  // underneath an already-rendered admin page — see
  // @/lib/use-session-identity-guard.
  return (
    <AdminShell userId={session.user.id} userEmail={session.user.email} signOutAction={signOutAction}>
      {children}
    </AdminShell>
  );
}
