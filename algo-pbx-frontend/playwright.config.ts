import { defineConfig, devices } from "@playwright/test";

// F5 scaffold. Every redesign flow gets a spec here; Playwright is the ONLY
// UI verification (vitest is node-env, no jsdom).
//
// Env:
//   E2E_BASE_URL        default http://localhost:3000
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
//   E2E_AGENT_EMAIL / E2E_AGENT_PASSWORD
//   E2E_PLATFORM_EMAIL / E2E_PLATFORM_PASSWORD / E2E_PLATFORM_TOTP_SECRET
//                       LOCAL/STAGING ONLY — never set against production
//   E2E_WEBSERVER=1     also boot `next start` for the run
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "admin",
      testMatch: /.*\.admin\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: ".auth/admin.json" },
    },
    {
      name: "agent",
      testMatch: /.*\.agent\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: ".auth/agent.json" },
    },
    {
      name: "mobile",
      testMatch: /.*\.mobile\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["iPhone 13"], storageState: ".auth/agent.json" },
    },
    {
      name: "anon",
      testMatch: /.*\.anon\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Owner console. Its own storageState because the platform plane has its
    // own session cookie (algopbx-platform-session) — a tenant state file
    // would carry the wrong cookie entirely, not merely the wrong role.
    //
    // Credentials are LOCAL/STAGING ONLY: no platform test account may exist
    // on production. See e2e/auth.setup.ts's guard, which refuses to run
    // against a production host even if the env is misconfigured.
    {
      name: "platform",
      testMatch: /.*\.platform\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: ".auth/platform.json" },
    },
  ],
  webServer: process.env.E2E_WEBSERVER
    ? {
        command: "npm run start",
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      }
    : undefined,
});
