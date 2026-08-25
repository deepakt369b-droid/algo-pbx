"use client";

import { useEffect, useState } from "react";
import { Box, Chip, Tooltip } from "@mui/material";
import Link from "next/link";

type OverallStatus = "ok" | "warn" | "fail" | "unknown";

const COLOR: Record<OverallStatus, "success" | "warning" | "error" | "default"> = {
  ok: "success",
  warn: "warning",
  fail: "error",
  unknown: "default",
};
const LABEL: Record<OverallStatus, string> = { ok: "All systems OK", warn: "Needs attention", fail: "Failing", unknown: "Checking…" };

const POLL_MS = 30000;

// Topbar health pill wired to GET /api/admin/system/health (Phase 7) —
// links straight to /admin/system so a red/yellow pill is one click from
// the fix, not just a warning icon nobody acts on.
export function HealthPill() {
  const [status, setStatus] = useState<OverallStatus>("unknown");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/system/health");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { overall: OverallStatus };
        if (!cancelled) setStatus(data.overall);
      } catch {
        if (!cancelled) setStatus("unknown");
      }
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <Tooltip title={LABEL[status]}>
      <Box component={Link} href="/admin/system" sx={{ textDecoration: "none" }}>
        <Chip size="small" color={COLOR[status]} label={LABEL[status]} sx={{ fontWeight: 600, cursor: "pointer" }} />
      </Box>
    </Tooltip>
  );
}
