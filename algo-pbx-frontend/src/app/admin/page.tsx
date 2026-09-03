import { auth } from "@/auth";
import { InterventionControls } from "@/components/intervention-controls";
import { Wallboard } from "@/components/wallboard";

export default async function AdminDashboard() {
  // Middleware already blocks non-ADMIN/SUPERVISOR from reaching this route;
  // session is guaranteed non-null here, but re-check rather than trusting
  // that invariant blindly inside a page component.
  const session = await auth();

  // Previously `session?.user.extension ?? "9000"` — a supervisor account
  // with no linked extension silently got a hardcoded "9000" fallback,
  // which was then POSTed to /api/intervention as the channel to
  // originate a spy/whisper/barge call FROM. That's the wrong failure
  // mode for a call-interception feature: silently substituting an
  // arbitrary extension instead of surfacing that the account isn't set
  // up to use this feature at all. Show an explicit, honest state
  // instead of guessing.
  if (!session?.user.extension) {
    return (
      <>
        <Wallboard />
        <div className="w-full max-w-3xl rounded-lg border border-border bg-surface p-4 text-sm text-secondary">
          Live call intervention (listen-in / whisper / barge) is unavailable: your account has no
          linked extension. Ask an admin to provision one under{" "}
          <a href="/admin/dinstar" className="text-cyan hover:underline">
            Extensions
          </a>
          .
        </div>
      </>
    );
  }

  return (
    <>
      <Wallboard />
      <InterventionControls supervisorExtension={session.user.extension} />
    </>
  );
}
