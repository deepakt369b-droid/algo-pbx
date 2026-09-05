import type { Config } from "tailwindcss";

// Same Apple-black token system as algo-pbx-frontend/tailwind.config.ts —
// colours resolve to CSS variables in src/app/globals.css. No hex here.
const solid = (v: string) => `rgb(var(${v}) / <alpha-value>)`;
const baked = (v: string) => `rgb(var(${v}))`;

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
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
        success: { DEFAULT: solid("--success"), subtle: baked("--success-subtle") },
        warning: { DEFAULT: solid("--warning"), subtle: baked("--warning-subtle") },
        danger: { DEFAULT: solid("--danger"), subtle: baked("--danger-subtle") },
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
