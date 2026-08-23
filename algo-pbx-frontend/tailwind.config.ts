import type { Config } from "tailwindcss";

// Algo IT brand: dark slate background, electric cyan + blue accents.
// See ALGO_PBX_MASTER_DOC.md §1 / §4 for the design language spec.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#0B0F19",
        surface: "#111827",
        border: "#1F2937",
        cyan: {
          DEFAULT: "#06B6D4",
        },
        blue: {
          DEFAULT: "#2563EB",
        },
      },
      backgroundImage: {
        "glass-gradient":
          "linear-gradient(135deg, rgba(6,182,212,0.08), rgba(37,99,235,0.08))",
      },
    },
  },
  plugins: [],
};

export default config;
