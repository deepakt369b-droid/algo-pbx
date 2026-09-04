import { platformHandlers } from "@/lib/platform-auth";

// Platform-plane equivalent of src/app/api/auth/[...nextauth]/route.ts —
// same force-dynamic reasoning (see that file's comment: without it, a
// sealed-request host bug drops the just-set cookie on sign-in redirects).
// Lives under /api/platform-auth, not /api/auth, per
// platform-auth.config.ts's `basePath` override — the two NextAuth
// instances must never share a callback path, or the tenant instance's
// route would try to handle a platform credentials submission (wrong
// provider config, wrong cookie) and vice versa.
export const dynamic = "force-dynamic";

export const { GET, POST } = platformHandlers;
