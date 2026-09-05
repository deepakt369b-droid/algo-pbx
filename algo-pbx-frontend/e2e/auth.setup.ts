import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import { TOTP } from "otpauth";

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

// ---------------------------------------------------------------------------
// Platform plane (owner console).
//
// A separate block, not another entry in `roles` above: the platform login is
// a different form on a different path, posts to its own auth endpoint, and
// carries a mandatory TOTP code. Its session cookie is separate too
// (algopbx-platform-session), which is exactly why a distinct storageState
// file works cleanly here.
//
// SAFETY RULE — these credentials are LOCAL/STAGING ONLY.
//
// No platform test account may exist on the production database. A platform
// account is the highest-privilege identity in the system: it can suspend,
// offboard, cut a dialplan, and grant itself read access to every tenant's
// call data. A test account with a password sitting in CI environment
// variables is not something that should ever exist against real customers.
//
// The guard below refuses to run against the known production host even if
// the environment is misconfigured, because "we'll be careful" is not a
// control.
// ---------------------------------------------------------------------------
const PRODUCTION_HOST_MARKERS = ["pbx.saharatechs.com", "algopbx.com"];

setup("authenticate as platform owner", async ({ page, baseURL }) => {
  const email = process.env.E2E_PLATFORM_EMAIL;
  const password = process.env.E2E_PLATFORM_PASSWORD;
  const totpSecret = process.env.E2E_PLATFORM_TOTP_SECRET;

  setup.skip(
    !email || !password || !totpSecret,
    "E2E_PLATFORM_EMAIL / _PASSWORD / _TOTP_SECRET not set",
  );

  const target = process.env.E2E_BASE_URL ?? baseURL ?? "";
  const looksProduction = PRODUCTION_HOST_MARKERS.some((h) => target.includes(h));
  if (looksProduction) {
    throw new Error(
      `Refusing to run platform E2E against "${target}". Platform test accounts must never exist on production — ` +
        `a platform account can suspend, offboard, cut a dialplan and read every tenant's call data. ` +
        `Point E2E_BASE_URL at a local or staging stack.`,
    );
  }

  if (!fs.existsSync(".auth")) fs.mkdirSync(".auth");

  await page.goto("/platform/login");
  await page.getByPlaceholder("you@algopbx.internal").fill(email!);
  await page.getByPlaceholder("Password").fill(password!);

  // Generated in-test from the seeded secret, using the same otpauth library
  // the server verifies with — so the test proves the real TOTP path works
  // rather than bypassing it.
  const code = new TOTP({ secret: totpSecret!, digits: 6, period: 30 }).generate();
  await page.getByPlaceholder(/6-digit authenticator code/).fill(code);

  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/platform") &&
      !url.pathname.startsWith("/platform/login") &&
      !url.pathname.startsWith("/platform/setup"),
    { timeout: 15_000 },
  );
  await expect(page.getByRole("heading", { name: /overview/i })).toBeVisible();
  await page.context().storageState({ path: ".auth/platform.json" });
});
