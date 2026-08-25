// SaaSable-shaped palette (github.com/phoenixcoded/saasable-ui, MIT) —
// grey/primary/secondary/semantic scales with light+dark variants,
// keeping Algo PBX's existing cyan/blue brand identity
// (ALGO_PBX_MASTER_DOC.md §1) as the primary/secondary hues rather than
// SaaSable's own colors, since this is a design-SYSTEM swap, not a
// re-brand.

import { PaletteOptions } from "@mui/material/styles";

const grey = {
  50: "#F8FAFC",
  100: "#F1F5F9",
  200: "#E2E8F0",
  300: "#CBD5E1",
  400: "#94A3B8",
  500: "#64748B",
  600: "#475569",
  700: "#334155",
  800: "#1E293B",
  900: "#0F172A",
};

export const lightPalette: PaletteOptions = {
  mode: "light",
  primary: { main: "#06B6D4", light: "#22D3EE", dark: "#0891B2", contrastText: "#0B0F19" },
  secondary: { main: "#2563EB", light: "#3B82F6", dark: "#1D4ED8", contrastText: "#FFFFFF" },
  success: { main: "#22C55E", light: "#4ADE80", dark: "#16A34A" },
  warning: { main: "#F59E0B", light: "#FBBF24", dark: "#D97706" },
  error: { main: "#EF4444", light: "#F87171", dark: "#DC2626" },
  info: { main: "#0EA5E9", light: "#38BDF8", dark: "#0284C7" },
  grey,
  background: { default: grey[50], paper: "#FFFFFF" },
  text: { primary: grey[900], secondary: grey[600], disabled: grey[400] },
  divider: grey[200],
};

export const darkPalette: PaletteOptions = {
  mode: "dark",
  primary: { main: "#06B6D4", light: "#22D3EE", dark: "#0891B2", contrastText: "#0B0F19" },
  secondary: { main: "#3B82F6", light: "#60A5FA", dark: "#2563EB", contrastText: "#FFFFFF" },
  success: { main: "#22C55E", light: "#4ADE80", dark: "#16A34A" },
  warning: { main: "#F59E0B", light: "#FBBF24", dark: "#D97706" },
  error: { main: "#F87171", light: "#FCA5A5", dark: "#EF4444" },
  info: { main: "#38BDF8", light: "#7DD3FC", dark: "#0EA5E9" },
  grey,
  background: { default: "#0B0F19", paper: "#111827" },
  text: { primary: "#F1F5F9", secondary: "#94A3B8", disabled: "#475569" },
  divider: "#1F2937",
};
