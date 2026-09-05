import { defineConfig, devices } from "@playwright/test";

// Minimal, self-contained config for this site only — deliberately not
// added to algo-pbx-frontend's 5-project playwright.config.ts (independent
// deploy surface, independent test run).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: "Desktop Chrome", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "iPhone 13", use: { ...devices["iPhone 13"] } },
  ],
});
