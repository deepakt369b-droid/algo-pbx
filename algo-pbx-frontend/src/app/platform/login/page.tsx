import { PlatformLoginForm } from "./login-form";

// Server component, structurally mirroring src/app/login/page.tsx — but
// deliberately WITHOUT that page's "already signed in, continue as X"
// branch. That branch exists there because the tenant plane keeps exactly
// one session cookie for every role and account-switch UX matters; the
// platform plane is a small, high-privilege operator console where
// showing "already signed in as X, continue?" adds a click for no real
// benefit, and requirePlatformSession()/the layout below already redirect
// a live session straight past this page via middleware.ts's platform
// branch. Kept simple on purpose.
export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <PlatformLoginForm callbackUrl={searchParams.callbackUrl} />
    </main>
  );
}
