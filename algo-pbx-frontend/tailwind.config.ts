import type { Config } from "tailwindcss";

// Apple-black design system (F1). Every colour resolves to a CSS variable
// defined in src/app/globals.css (light on :root, dark on
// :root[data-theme="dark"] + prefers-color-scheme). No hex lives here.
//
// Two families:
//  - solid tokens   -> "rgb(var(--x) / <alpha-value>)"  (supports /10 etc.)
//  - pre-baked alpha -> "rgb(var(--x))"                  (hairlines, *-subtle)
const solid = (v: string) => `rgb(var(${v}) / <alpha-value>)`;
const baked = (v: string) => `rgb(var(${v}))`;

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  // Explicit choice wins; system default handled by CSS media query.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // ---- semantic (target names; F2 migrates call sites here) ----
        canvas: solid("--canvas"),
        surface: {
          DEFAULT: solid("--surface"),
          subtle: solid("--surface-subtle"),
          hover: solid("--surface-hover"),
        },
        hairline: {
          DEFAULT: baked("--hairline"),
          strong: baked("--hairline-strong"),
        },
        primary: solid("--text-primary"),
        secondary: solid("--text-secondary"),
        tertiary: solid("--text-tertiary"),
        accent: {
          DEFAULT: solid("--accent"),
          hover: solid("--accent-hover"),
          subtle: baked("--accent-subtle"),
          fg: solid("--text-on-accent"),
        },
        success: {
          DEFAULT: solid("--success"),
          subtle: baked("--success-subtle"),
        },
        warning: {
          DEFAULT: solid("--warning"),
          subtle: baked("--warning-subtle"),
        },
        danger: {
          DEFAULT: solid("--danger"),
          subtle: baked("--danger-subtle"),
        },

        // ---- legacy names, repointed so existing pages re-skin now ----
        background: solid("--canvas"),
        border: baked("--hairline"),
        cyan: { DEFAULT: solid("--accent") },
        blue: { DEFAULT: solid("--accent") },
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        lg: "var(--radius-lg)",
      },
      ringColor: {
        DEFAULT: baked("--ring"),
      },
    },
  },
  plugins: [],
};

export default config;
