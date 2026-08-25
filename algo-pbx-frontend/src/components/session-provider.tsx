"use client";

import { SessionProvider } from "next-auth/react";

// Thin wrapper so layout.tsx (a server component) can still render a client
// provider — next-auth/react's useSession() (used by sip-context.tsx to know
// which extension to PATCH status for) doesn't work without this ancestor.
export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
