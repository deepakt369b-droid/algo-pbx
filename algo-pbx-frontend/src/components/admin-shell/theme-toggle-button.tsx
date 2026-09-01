"use client";

import { Moon, Sun } from "lucide-react";
import { useThemeMode } from "@/theme/theme-provider";

/** Header sun/moon. Flips the resolved theme; long-term the settings page
 * exposes the full light/dark/system choice. Rendered in both shells. */
export function ThemeToggleButton() {
  const { resolved, toggle } = useThemeMode();
  const toDark = resolved === "light";
  return (
    <button
      type="button"
      onClick={toggle}
      title={toDark ? "Switch to dark" : "Switch to light"}
      aria-label={toDark ? "Switch to dark theme" : "Switch to light theme"}
      className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border text-secondary transition-colors hover:bg-surface-hover hover:text-primary"
      style={{ borderColor: "rgb(var(--hairline))" }}
    >
      {toDark ? <Moon size={17} /> : <Sun size={17} />}
    </button>
  );
}
