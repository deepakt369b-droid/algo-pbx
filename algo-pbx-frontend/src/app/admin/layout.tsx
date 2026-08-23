import Link from "next/link";
import { auth, signOut } from "@/auth";

// Extracted from admin/page.tsx, which previously rendered this nav
// inline — meaning it existed ONLY on /admin itself. Every other admin
// subpage (/admin/queues, /cdr, /extensions, /users, /dnc) rendered with
// no navigation at all; a user who followed a link into one of them had
// no way back except the browser's Back button. This layout now wraps
// every /admin/* route (middleware.ts already restricts the whole
// subtree to ADMIN/SUPERVISOR), so the fix applies everywhere at once and
// there's a single place to add new sections (WhatsApp, SMS, Rooms below)
// rather than duplicating a nav block into every page file.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
        <div className="flex w-full items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-100">Supervisor / Admin Dashboard</h1>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <span>{session?.user.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button className="rounded-lg border border-border px-3 py-1.5 hover:border-cyan hover:text-cyan">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="flex flex-wrap gap-4 border-b border-border pb-4 text-sm text-slate-400">
          <Link href="/admin" className="hover:text-cyan">
            Wallboard
          </Link>
          <Link href="/admin/queues" className="hover:text-cyan">
            Queues
          </Link>
          <Link href="/admin/cdr" className="hover:text-cyan">
            CDR
          </Link>
          <Link href="/admin/extensions" className="hover:text-cyan">
            Extensions
          </Link>
          <Link href="/admin/users" className="hover:text-cyan">
            Users
          </Link>
          <Link href="/admin/dnc" className="hover:text-cyan">
            Do Not Call
          </Link>
          <Link href="/admin/whatsapp" className="hover:text-cyan">
            WhatsApp
          </Link>
          <Link href="/admin/sms" className="hover:text-cyan">
            SIM SMS
          </Link>
          <Link href="/admin/rooms" className="hover:text-cyan">
            Rooms
          </Link>
          <Link href="/admin/sign-ins" className="hover:text-cyan">
            Sign-Ins
          </Link>
          <Link href="/admin/reports" className="hover:text-cyan">
            Reports
          </Link>
          <Link href="/admin/settings" className="hover:text-cyan">
            Settings
          </Link>
        </nav>
        {children}
      </div>
    </div>
  );
}
