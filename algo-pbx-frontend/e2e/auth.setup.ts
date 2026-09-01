import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";

// Logs in once per role and saves storageState. Skips (with a clear message)
// when creds are absent so the suite still runs its anon specs.
const roles = [
  {
    name: "admin",
    email: process.env.E2E_ADMIN_EMAIL,
    password: process.env.E2E_ADMIN_PASSWORD,
    landing: "/admin",
    file: ".auth/admin.json",
  },
  {
    name: "agent",
    email: process.env.E2E_AGENT_EMAIL,
    password: process.env.E2E_AGENT_PASSWORD,
    landing: "/agent",
    file: ".auth/agent.json",
  },
];

for (const role of roles) {
  setup(`authenticate as ${role.name}`, async ({ page }) => {
    setup.skip(
      !role.email || !role.password,
      `E2E_${role.name.toUpperCase()}_EMAIL / _PASSWORD not set`,
    );
    if (!fs.existsSync(".auth")) fs.mkdirSync(".auth");

    await page.goto("/login");
    await page.getByPlaceholder("you@algopbx.local").fill(role.email!);
    await page.getByPlaceholder("Password").fill(role.password!);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
    await expect(page).toHaveURL(new RegExp(role.landing));
    await page.context().storageState({ path: role.file });
  });
}
