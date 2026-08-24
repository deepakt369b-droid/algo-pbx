import { createTheme, type ThemeOptions } from "@mui/material/styles";
import { darkPalette, lightPalette } from "./palette";

// SaaSable-shaped design tokens layered on top of the palette: 12/16px
// radii, soft layered shadows instead of Material's harsh default
// elevation, an 8px spacing rhythm (MUI's default — kept explicit so it
// isn't accidentally changed), and a type scale a notch tighter than
// Material defaults (SaaSable favors compact, dense admin-UI typography).
const shape = { borderRadius: 12 };

const typography: ThemeOptions["typography"] = {
  fontFamily: "var(--font-inter, 'Inter', 'Segoe UI', system-ui, sans-serif)",
  h1: { fontSize: "2.5rem", fontWeight: 700, lineHeight: 1.2 },
  h2: { fontSize: "2rem", fontWeight: 700, lineHeight: 1.25 },
  h3: { fontSize: "1.5rem", fontWeight: 600, lineHeight: 1.3 },
  h4: { fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.35 },
  h5: { fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.4 },
  h6: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.4 },
  body1: { fontSize: "0.9375rem", lineHeight: 1.6 },
  body2: { fontSize: "0.8125rem", lineHeight: 1.55 },
  button: { textTransform: "none", fontWeight: 600 },
};

function softShadow(rgb: string): string[] {
  return [
    "none",
    `0 1px 2px 0 rgba(${rgb},0.06)`,
    `0 1px 3px 0 rgba(${rgb},0.08), 0 1px 2px -1px rgba(${rgb},0.08)`,
    `0 4px 6px -1px rgba(${rgb},0.08), 0 2px 4px -2px rgba(${rgb},0.06)`,
    `0 10px 15px -3px rgba(${rgb},0.08), 0 4px 6px -4px rgba(${rgb},0.06)`,
    ...Array(20).fill(`0 20px 25px -5px rgba(${rgb},0.1), 0 8px 10px -6px rgba(${rgb},0.06)`),
  ];
}

function buildTheme(mode: "light" | "dark") {
  const palette = mode === "light" ? lightPalette : darkPalette;
  const shadowRgb = mode === "light" ? "15,23,42" : "0,0,0";

  return createTheme({
    palette,
    shape,
    typography,
    shadows: softShadow(shadowRgb) as unknown as ThemeOptions["shadows"],
    components: {
      MuiButton: {
        styleOverrides: {
          root: { borderRadius: 10, paddingInline: 16 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 16,
            border: `1px solid ${theme.palette.divider}`,
          }),
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 8, fontWeight: 600 },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: ({ theme }) => ({ borderColor: theme.palette.divider }),
        },
      },
    },
  });
}

export const lightTheme = buildTheme("light");
export const darkTheme = buildTheme("dark");
