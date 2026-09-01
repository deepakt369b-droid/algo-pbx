"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ThemeProvider as MuiThemeProvider, CssBaseline } from "@mui/material";
import { darkTheme, lightTheme } from "./index";

// Three-state preference. "system" (the default) stamps no attribute and
// lets prefers-color-scheme decide; an explicit choice stamps
// <html data-theme="light|dark">. The CSS-variable token layer in
// globals.css keys off exactly that, so this provider only manages the
// attribute + persistence. (The MUI wrapper below is transitional — it is
// deleted in F6 along with the @mui/@emotion packages.)
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "algopbx-theme-mode";

function isPreference(v: string | null): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

type ThemeContextValue = {
  /** The user's stored choice. */
  preference: ThemePreference;
  /** What is actually showing right now (system resolved against the OS). */
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
  /** Convenience for the header sun/moon button: flips the *resolved* theme. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "dark",
  setPreference: () => {},
  toggle: () => {},
});

export const useThemeMode = () => useContext(ThemeContext);

/** Runs before hydration (a <script> in layout.tsx) so there is no flash. */
export const NO_FLASH_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("${STORAGE_KEY}");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  } catch (e) {}
})();
`;

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyPreference(pref: ThemePreference) {
  const el = document.documentElement;
  if (pref === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", pref);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>("dark");

  // Hydrate the stored preference + current system value on mount.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isPreference(stored)) setPreferenceState(stored);
    setSystemResolved(systemTheme());

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* private mode — in-memory only */
    }
    applyPreference(p);
  }, []);

  const resolved: ResolvedTheme =
    preference === "system" ? systemResolved : preference;

  const toggle = useCallback(() => {
    setPreference(resolved === "dark" ? "light" : "dark");
  }, [resolved, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );

  const muiTheme = useMemo(
    () => (resolved === "light" ? lightTheme : darkTheme),
    [resolved],
  );

  return (
    <ThemeContext.Provider value={value}>
      <MuiThemeProvider theme={muiTheme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
}
