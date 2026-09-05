import { auth, signOut } from "@/auth";
import { AgentShell } from "@/components/agent-shell/agent-shell";
import { CrmCallLayer } from "@/components/crm/crm-call-layer";
import { SupportAccessBanner } from "@/components/support-access-banner";
import { getActiveGrantForTenant } from "@/lib/support-grant";

// Mirrors admin/layout.tsx's pattern exactly: server component fetches
// the session and hands a server action down to the client shell, which
// needs client-side state (useSIP's live connection status) that a server
// component can't hold. Before this file existed, `/agent` had ZERO page
// chrome — no sign-out, no connection indicator — because it inherited
// only the root layout's providers (AuthSessionProvider/SIPProvider/
// ThemeProvider), never a page shell of its own.
export default async function AgentLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  // "No silent impersonation" (plan §3): while a platform operator holds a
  // live support grant into this tenant, every page of the tenant UI says so,
  // naming them and the expiry. This is the guarantee the customer is given —
  // the grant machinery is worthless to them if they cannot see it — so it is
  // rendered inside the shell rather than on individual pages, where it could
  // be missed off one.
  const grant = session?.user.tenantId
    ? await getActiveGrantForTenant(session.user.tenantId)
    : null;

  // userId is passed so AgentShell can detect the session cookie being
  // replaced underneath an already-rendered page — see
  // @/lib/use-session-identity-guard. Without it, an admin signing in on the
  // same browser left this agent workspace rendering ADMIN chrome (including
  // agent-shell's "Admin" link) against the admin's cookie.
  return (
    <AgentShell
      userId={session?.user.id}
      userEmail={session?.user.email}
      role={session?.user.role}
      signOutAction={signOutAction}
    >
      <SupportAccessBanner grant={grant} />
      <CrmCallLayer>{children}</CrmCallLayer>
    </AgentShell>
  );
}
