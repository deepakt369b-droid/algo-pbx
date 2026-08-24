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

  return (
    <AdminShell userEmail={session?.user.email} signOutAction={signOutAction}>
      {children}
    </AdminShell>
  );
}
