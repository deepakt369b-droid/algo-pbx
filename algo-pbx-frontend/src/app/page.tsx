"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Box, Button, Typography } from "@mui/material";

// Client-only: WebGL/three.js has no server-rendered form. `ssr: false` on
// next/dynamic is only honored inside a Client Component — in a Server
// Component (this file without "use client") Next 14's App Router
// silently still traces the dynamically-imported module into the SERVER
// bundle for page-data collection, which pulled the entire three.js/
// postprocessing graph server-side and crashed on an unrelated internal
// MUI export during that trace ("unstable_createUseMediaQuery is not a
// function") — a module-evaluation-order artifact of bundling
// server-incompatible code, not a real MUI bug. Marking this whole page a
// Client Component is what actually keeps GradientBackground's module
// graph out of the server bundle.
const GradientBackground = dynamic(
  () => import("@/components/landing/gradient-background").then((m) => m.GradientBackground),
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
      <GradientBackground />
      <Box
        aria-hidden
        sx={{ position: "absolute", inset: 0, zIndex: -5, background: "linear-gradient(180deg, rgba(11,15,25,0.2) 0%, rgba(11,15,25,0.75) 100%)" }}
      />

      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, textAlign: "center", maxWidth: 560 }}>
        <Typography variant="h1" sx={{ fontSize: { xs: "2.25rem", sm: "3rem" } }}>
          Algo PBX
        </Typography>
        <Typography variant="body1" sx={{ color: "rgba(255,255,255,0.8)" }}>
          Self-hosted cloud PBX for the Algo call center. Sign in to reach your workspace.
        </Typography>
      </Box>

      <Box sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 2 }}>
        <Button component={Link} href="/agent" variant="contained" size="large" sx={{ minWidth: 200 }}>
          Agent Workspace
        </Button>
        <Button component={Link} href="/admin" variant="outlined" size="large" color="inherit" sx={{ minWidth: 200, borderColor: "rgba(255,255,255,0.4)" }}>
          Admin Dashboard
        </Button>
      </Box>
    </Box>
  );
}
