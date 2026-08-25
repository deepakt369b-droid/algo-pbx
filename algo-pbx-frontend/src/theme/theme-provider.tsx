"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ThemeProvider as MuiThemeProvider, CssBaseline } from "@mui/material";
import { darkTheme, lightTheme } from "./index";

type Mode = "light" | "dark";
const STORAGE_KEY = "algopbx-theme-mode";

const ModeContext = createContext<{ mode: Mode; toggle: () => void }>({ mode: "dark", toggle: () => {} });
export const useThemeMode = () => useContext(ModeContext);

/** Inline, runs before hydration via a <script> in layout.tsx — reads the
 * stored preference and stamps the class synchronously so there is no
 * flash of the wrong theme between paint and React mounting. */
export const NO_FLASH_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem("${STORAGE_KEY}");
    var mode = stored === "light" || stored === "dark" ? stored : "dark";
    document.documentElement.setAttribute("data-theme", mode);
  } catch (e) {}
})();
`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("dark");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") setMode(stored);
  }, []);

  const toggle = () => {
    setMode((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  };

  const theme = useMemo(() => (mode === "light" ? lightTheme : darkTheme), [mode]);

  return (
    <ModeContext.Provider value={{ mode, toggle }}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ModeContext.Provider>
  );
}
