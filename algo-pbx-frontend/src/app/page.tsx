import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <h1 className="text-3xl font-semibold text-slate-100">Algo PBX</h1>
      <p className="max-w-md text-center text-slate-400">
        Both workspaces below require sign-in — you'll be redirected to
        /login if you're not authenticated.
      </p>
      <div className="flex gap-4">
        <Link href="/agent" className="glass-card px-6 py-3 text-cyan hover:brightness-125">
          Agent Workspace
        </Link>
        <Link href="/admin" className="glass-card px-6 py-3 text-blue hover:brightness-125">
          Admin Dashboard
        </Link>
      </div>
    </main>
  );
}
