import Link from "next/link";
import { auth, signOut } from "@/auth";
import { workspaceForRole } from "@/lib/workspace-for-role";
import { LoginForm } from "./login-form";

// Server component on purpose. This page used to render the credentials
// form unconditionally, which made a silent, browser-wide account takeover
// trivially reachable: Auth.js keeps ONE `authjs.session-token` cookie at
// `path=/` (auth.config.ts declares no `cookies:` block), so signing in as a
// second account does not open a second session — login-form's signIn()
// overwrites the existing cookie in place, for every open tab at once.
//
// Reported live 2026-08-29 as "the agent account has an admin account
// switch", reproduced by having both accounts open in one browser: after the
// admin signed in, the still-open /agent tab re-rendered against the admin
// cookie and drew agent-shell.tsx's ADMIN-only "Admin" link, which genuinely
// worked because the cookie really was the admin's.
//
// Signing in as someone else is a deliberate act, so make it one: if a live
// session already exists, say whose it is and require an explicit sign-out
// first. Pairs with useSessionIdentityGuard(), which catches the other half
// (a cookie that changes underneath an already-rendered page).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string };
}) {
  const session = await auth();

  // `disabled` is recomputed live from the DB by src/auth.ts's jwt callback;
  // a disabled session is treated as no session at all (same rule as
  // src/lib/auth-guard.ts) so a deactivated user still gets the form.
  if (session?.user && !session.user.disabled) {
    const workspace = workspaceForRole(session.user.role);

    async function signOutAction() {
      "use server";
      await signOut({ redirectTo: "/login" });
    }

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8">
        <div className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
          <h1 className="text-lg font-semibold text-primary">Already signed in</h1>
          <p className="text-sm text-secondary">
            This browser is signed in as{" "}
            <span className="font-medium text-primary">{session.user.email}</span>
            {session.user.role ? ` (${session.user.role.toLowerCase()})` : ""}.
          </p>
          <p className="text-xs text-tertiary">
            Signing in as someone else replaces this session in every tab of this
            browser, including any open softphone. Sign out first.
          </p>
          <Link
            href={workspace}
            className="rounded-lg bg-cyan px-4 py-2 text-center font-medium text-accent-fg transition hover:brightness-110"
          >
            Continue as {session.user.email}
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full rounded-lg border border-border px-4 py-2 text-sm text-secondary transition hover:border-cyan hover:text-primary"
            >
              Sign out and use a different account
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <LoginForm callbackUrl={searchParams.callbackUrl} />
    </main>
  );
}
