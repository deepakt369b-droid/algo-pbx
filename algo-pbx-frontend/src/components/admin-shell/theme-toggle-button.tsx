"use client";

import { IconButton } from "@mui/material";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import { useThemeMode } from "@/theme/theme-provider";

export function ThemeToggleButton() {
  const { mode, toggle } = useThemeMode();
  return (
    <IconButton size="small" onClick={toggle} title={mode === "dark" ? "Switch to light" : "Switch to dark"}>
      {mode === "dark" ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
    </IconButton>
  );
}
