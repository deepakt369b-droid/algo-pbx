"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Box, Button, Typography } from "@mui/material";

// Landing page — "Algo PBX, wired for SAHARA". One purpose: funnel every
// visitor (admin, supervisor, agent) through the single unified login;
// there are deliberately no per-role entry buttons here. The role-based
// destination is decided at sign-in (see login-form.tsx).
//
// Client-only: WebGL/three.js has no server-rendered form. `ssr: false` on
// next/dynamic is only honored inside a Client Component — in a Server
// Component Next 14's App Router silently still traces the dynamically
// imported module into the SERVER bundle for page-data collection.
// Marking this whole page a Client Component is what keeps the Scanner's
// module graph out of the server bundle.
const ScannerBackground = dynamic(
  () => import("@/components/landing/scanner-background").then((m) => m.ScannerBackground),
  { ssr: false }
);

export default function Home() {
  return (
    <Box
      component="main"
      sx={{
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        p: 4,
        overflow: "hidden",
        color: "common.white",
      }}
    >
      <ScannerBackground />
      <Box
        aria-hidden
        sx={{ position: "absolute", inset: 0, zIndex: -5, background: "linear-gradient(180deg, rgba(11,15,25,0.2) 0%, rgba(11,15,25,0.75) 100%)" }}
      />

      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, textAlign: "center", maxWidth: 560 }}>
        <Typography variant="h1" sx={{ fontSize: { xs: "2.25rem", sm: "3rem" } }}>
          Algo PBX
        </Typography>
        <Typography
          variant="body1"
          sx={{ color: "rgba(255,255,255,0.85)", letterSpacing: "0.18em", textTransform: "uppercase", fontSize: "0.875rem" }}
        >
          Wired for SAHARA
        </Typography>
        <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.65)" }}>
          Self-hosted cloud PBX. Sign in to reach your workspace.
        </Typography>
      </Box>

      <Button component={Link} href="/login" variant="contained" size="large" sx={{ minWidth: 220 }}>
        Sign In
      </Button>
    </Box>
  );
}
