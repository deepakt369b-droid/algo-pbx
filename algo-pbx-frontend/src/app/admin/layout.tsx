import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { AdminShell } from "@/components/admin-shell/admin-shell";
import { SupportAccessBanner } from "@/components/support-access-banner";
import { BillingWarningBanner } from "@/components/billing-warning-banner";
import { getActiveGrantForTenant } from "@/lib/support-grant";
import { unsafeGlobalDb as db } from "@/lib/db";
import { evaluateBillingAccess } from "@/lib/billing/enforcement";

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
  // Billing enforcement, layout half. authorize() already refuses to MINT a
  // session past the grace window, but a session minted before the lapse is
  // still valid until it expires — so the state is re-checked here on every
  // page load, the same live-recheck reasoning platform-guard.ts applies to
  // PlatformUser.disabled. UI ACCESS ONLY: nothing here touches telephony.
  const tenant = await db.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { billingStatus: true, paidUntil: true, status: true },
  });
  const access = tenant ? evaluateBillingAccess(tenant) : null;
  if (access?.rung === "login_blocked") {
    redirect("/billing-hold");
  }

  // "No silent impersonation" (plan §3): while a platform operator holds a
  // live support grant into this tenant, the admin UI says so on every page,
  // naming them and the expiry. Rendered in the layout rather than per page
  // so it cannot be omitted from one.
  const grant = await getActiveGrantForTenant(session.user.tenantId);

  return (
    <AdminShell userId={session.user.id} userEmail={session.user.email} signOutAction={signOutAction}>
      <SupportAccessBanner grant={grant} />
      <BillingWarningBanner access={access} />
      {children}
    </AdminShell>
  );
}
