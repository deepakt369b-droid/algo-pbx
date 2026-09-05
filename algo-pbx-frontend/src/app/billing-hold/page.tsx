import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { unsafeGlobalDb as db } from "@/lib/db";
import { evaluateBillingAccess } from "@/lib/billing/enforcement";
import { TELEPHONY_UNAFFECTED_NOTE } from "@/lib/platform/blast-radius";

export const dynamic = "force-dynamic";

// Where a tenant ADMIN lands when their workspace is past the grace window.
//
// The page has one job beyond stating the problem: stop the customer
// panicking about an outage they do not have. Their agents cannot sign in,
// which looks alarming, and the instinctive assumption is that their phones
// have stopped too. They have not, and saying so plainly here — in the same
// wording the platform console uses — is the difference between a billing
// conversation and an emergency.
//
// Deliberately outside /admin: the admin shell's nav would offer links to
// pages this session is not meant to use.

export default async function BillingHoldPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const tenant = await db.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { name: true, paidUntil: true, billingStatus: true, status: true },
  });
  if (!tenant) redirect("/login");

  const access = evaluateBillingAccess(tenant);
  // Access restored (or never blocked) — nothing to hold them on.
  if (access.rung !== "login_blocked") redirect("/admin");

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-lg space-y-5 rounded-[var(--radius-lg)] border bg-surface p-7 [border-color:rgb(var(--hairline))]">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-primary">Account on hold</h1>
          <p className="text-[13px] text-secondary">{tenant.name}</p>
        </div>

        <p className="text-[13px] text-secondary">
          Access to the workspace is limited because payment is overdue. Your team cannot sign in
          until this is settled — you can, so you can resolve it.
        </p>

        {/* The reassurance is the point of this page. */}
        <div
          data-testid="calls-unaffected-notice"
          className="rounded-[var(--radius)] border border-success/30 bg-success/10 p-3 text-[13px] text-success"
        >
          <p className="font-medium">Your calls are still running.</p>
          <p className="mt-0.5">
            Inbound and outbound calling is completely unaffected. Nothing about this hold stops
            your phones, and your customers will not notice anything.
          </p>
        </div>

        <dl className="space-y-1.5 text-[13px]">
          <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
            <dt className="text-tertiary">Billing status</dt>
            <dd className="text-primary">{tenant.billingStatus}</dd>
          </div>
          <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
            <dt className="text-tertiary">Paid until</dt>
            <dd className="text-primary">
              {tenant.paidUntil ? tenant.paidUntil.toISOString().slice(0, 10) : "—"}
            </dd>
          </div>
        </dl>

        <p className="text-[13px] text-secondary">
          Contact Algo PBX to settle the invoice. Access is restored immediately once payment is
          recorded — there is nothing else you need to do.
        </p>

        <p className="text-[11px] text-tertiary">{TELEPHONY_UNAFFECTED_NOTE}</p>

        <form action={signOutAction}>
          <button
            type="submit"
            className="text-[13px] text-secondary underline underline-offset-2 hover:text-primary"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
