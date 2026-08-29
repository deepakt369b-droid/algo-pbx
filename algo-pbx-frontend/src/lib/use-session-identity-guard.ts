"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

// Guards against a page shell continuing to render one user's workspace
// after a DIFFERENT user's session cookie has replaced it browser-wide.
//
// Why this is needed at all: Auth.js stores the session in a single
// `authjs.session-token` cookie at `path=/` (auth.config.ts sets no
// `cookies:` block), so every tab in a browser shares one identity. Signing
// in as a second account does not open a second session — `signIn()`
// overwrites the cookie in place. The layouts here are server components
// that read `await auth()` ONCE at render time, so an already-rendered
// `/agent` tab kept showing agent chrome that was now being driven by an
// admin cookie: agent-shell.tsx renders an "Admin" link whenever `role` is
// ADMIN/SUPERVISOR, and middleware only role-gates `/admin`, so that link
// genuinely worked. Reported live 2026-08-29 as "the agent account has an
// admin account switch", reproduced by having both accounts open in one
// browser.
//
// The API routes were never the hole — all 35 `/api/admin/**` handlers
// independently call requireAdminSession()/requireStaffSession(). The hole
// is that the app had no notion of "this rendered page belongs to user X",
// so privileged chrome (and any already-painted privileged data) outlived
// the identity that was allowed to see it.
//
// Fix: the layout passes down the id it actually rendered for, and this
// compares it against the live client session. A mismatch means the cookie
// changed underneath us, and the only safe response is a full reload so the
// server re-renders for whoever the cookie now belongs to.
const RELOAD_GUARD_KEY = "algopbx:identity-reload-at";
const RELOAD_DEBOUNCE_MS = 5000;

export function useSessionIdentityGuard(renderedUserId?: string | null) {
  const { data, status } = useSession();
  const liveUserId = data?.user?.id;

  useEffect(() => {
    if (status !== "authenticated") return;
    // Either side missing means we simply cannot compare — never reload on
    // incomplete information, that is how you build a reload loop.
    if (!renderedUserId || !liveUserId) return;
    if (liveUserId === renderedUserId) return;

    // Debounce across reloads. If the server somehow re-renders with the
    // same stale id (a cached RSC payload, say), this stops the mismatch
    // from becoming an infinite refresh instead of a one-time correction.
    try {
      const last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
      if (Date.now() - last < RELOAD_DEBOUNCE_MS) return;
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      // Private mode / storage disabled — proceed with the reload anyway.
      // A redundant reload is a far better failure than silently leaving
      // one user looking at another user's workspace.
    }
    window.location.reload();
  }, [status, liveUserId, renderedUserId]);
}
