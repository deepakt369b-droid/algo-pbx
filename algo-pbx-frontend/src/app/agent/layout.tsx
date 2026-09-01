import { auth, signOut } from "@/auth";
import { AgentShell } from "@/components/agent-shell/agent-shell";
import { CrmCallLayer } from "@/components/crm/crm-call-layer";

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
      <CrmCallLayer>{children}</CrmCallLayer>
    </AgentShell>
  );
}
