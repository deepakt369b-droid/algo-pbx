import { auth, signOut } from "@/auth";
import { AgentShell } from "@/components/agent-shell/agent-shell";

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

  return (
    <AgentShell userEmail={session?.user.email} role={session?.user.role} signOutAction={signOutAction}>
      {children}
    </AgentShell>
  );
}
