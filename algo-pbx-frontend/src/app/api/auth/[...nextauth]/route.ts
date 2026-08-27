import { handlers } from "@/auth";

// Without this, Next.js can treat this route as a static-optimization
// candidate and "seal" the request object for cache-safety — its
// nextUrl.href/toString() get forced to a hardcoded placeholder host
// (http://localhost:3000, see next/dist/compiled/next-server's sealed-
// request proxy) instead of the real incoming Host header. Auth.js's
// default redirect callback reads that sealed baseUrl, so a real sign-in
// from e.g. http://127.0.0.1:3000 got redirected to a bare
// http://localhost:3000 — a different origin, so the browser drops the
// just-set session cookie and bounces straight back to /login. Every
// other API route in this codebase already force-dynamics itself for
// unrelated reasons (see pre-login/verify's own `dynamic` export); this
// one needs it for this reason specifically.
export const dynamic = "force-dynamic";

export const { GET, POST } = handlers;
