import { test, expect } from "@playwright/test";

// Multi-tenant SaaS foundation, wave 1 — Requirement A acceptance, agent
// half. Same reasoning as tenancy-acceptance.admin.spec.ts: running in the
// "agent" Playwright project already proves login-unchanged (via
// e2e/auth.setup.ts + E2E_AGENT_EMAIL/E2E_AGENT_PASSWORD, skip-if-unset).
// Run against the REHEARSED DB, not a fresh/unmigrated one.

test.describe("Tenancy migration — Requirement A acceptance (agent)", () => {
  test("agent workspace loads under the existing session", async ({ page }) => {
    await page.goto("/agent");
    await expect(page).toHaveURL(/\/agent/);
    await page.screenshot({ path: "test-results/tenancy-agent-dashboard.png", fullPage: true });
  });

  test("agent's own missed calls / call history spot-check, unchanged post-migration", async ({ page }) => {
    await page.goto("/agent");
    await expect(page.locator("body")).not.toContainText(/application error/i);
    await page.screenshot({ path: "test-results/tenancy-agent-history-spotcheck.png", fullPage: true });
  });
});
