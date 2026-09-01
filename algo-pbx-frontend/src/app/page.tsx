"use client";

import dynamic from "next/dynamic";
import Link from "next/link";

// Landing page — "Algo PBX, wired for SAHARA". One purpose: funnel every
// visitor (admin, supervisor, agent) through the single unified login;
// there are deliberately no per-role entry buttons here. The role-based
// destination is decided at sign-in (see login-form.tsx).
//
// Client-only: WebGL/three.js has no server-rendered form. `ssr: false` on
// next/dynamic is only honored inside a Client Component.
const ScannerBackground = dynamic(
  () => import("@/components/landing/scanner-background").then((m) => m.ScannerBackground),
  { ssr: false },
);

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden bg-black p-6 text-white">
      <ScannerBackground />
      <div
        aria-hidden
        className="absolute inset-0 -z-[5]"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.78) 100%)",
        }}
      />

      <div className="flex max-w-[560px] flex-col items-center gap-3 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Algo PBX</h1>
        <p className="text-sm uppercase tracking-[0.18em] text-white/85">Wired for SAHARA</p>
        <p className="text-sm text-white/65">
          Self-hosted cloud PBX. Sign in to reach your workspace.
        </p>
      </div>

      <Link
        href="/login"
        className="inline-flex h-11 min-w-[220px] items-center justify-center rounded-[10px] bg-[rgb(10_132_255)] px-6 text-[15px] font-medium text-white transition-colors hover:bg-[rgb(0_113_227)]"
      >
        Sign In
      </Link>
    </main>
  );
}
