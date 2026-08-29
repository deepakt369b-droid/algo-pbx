"use client";

import { SessionProvider } from "next-auth/react";

// Thin wrapper so layout.tsx (a server component) can still render a client
// provider — next-auth/react's useSession() (used by sip-context.tsx to know
// which extension to PATCH status for) doesn't work without this ancestor.
// refetchInterval: without it, useSession() only re-reads the cookie on
// mount and window focus, so a session swapped in another tab could go
// unnoticed here for as long as the tab stayed focused. 60s bounds how long
// useSessionIdentityGuard() and sip-context's credential effect can be
// looking at a stale identity. refetchOnWindowFocus stays on (its default)
// so the common case — switching back to the tab — is still immediate.
export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider refetchInterval={60}>{children}</SessionProvider>;
}
