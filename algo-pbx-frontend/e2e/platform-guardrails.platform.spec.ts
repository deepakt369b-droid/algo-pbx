import { test, expect } from "@playwright/test";

// ACCEPTANCE 3 — guardrails.
//
//   1. Last-owner demotion (and disable) refused.
//   2. Tenant login rejects a platform account.
//   3. Dialplan cut requires typed confirmation AND is absent from the
//      billing action set.
//
// The third is the one worth stating plainly: the console's central safety
// property is that billing enforcement and telephony are separate, and the
// clearest mechanical expression of that is "you cannot reach the kill switch
// from the billing tab". This spec fails if anyone ever moves it there for
// convenience.

test.describe("platform guardrails", () => {
  test("the last enabled owner cannot be disabled or demoted", async ({ page }) => {
    await page.goto("/platform/users");
    await expect(page.getByTestId("platform-users-table")).toBeVisible();

    const ownerCountText = (await page.getByTestId("owner-count").textContent()) ?? "";
    const enabledOwners = Number(/^(\d+)/.exec(ownerCountText.trim())?.[1] ?? "0");

    test.skip(
      enabledOwners !== 1,
      `This assertion is only meaningful with exactly one enabled owner (found ${enabledOwners}).`,
    );

    const ownerRow = page.locator('[data-testid="platform-user-row"][data-role="PLATFORM_OWNER"]').first();
    await expect(ownerRow).toBeVisible();

    // Both controls are present but refuse, and say why — a control that
    // silently vanished would leave the operator wondering if they lack
    // permission rather than understanding the rule.
    const disable = ownerRow.getByTestId("action-disable-user");
    const demote = ownerRow.getByTestId("action-change-role");

    await expect(disable).toBeDisabled();
    await expect(demote).toBeDisabled();
    await expect(disable).toHaveAttribute("title", /last enabled PLATFORM_OWNER/i);
    await expect(demote).toHaveAttribute("title", /last enabled PLATFORM_OWNER/i);

    await page.screenshot({ path: "e2e/screenshots/guardrail-last-owner.png", fullPage: true });
  });

  test("the API refuses a last-owner demotion even when called directly", async ({ request, page }) => {
    // The UI disabling a button is courtesy; the server is the enforcement.
    await page.goto("/platform/users");
    const rows = page.locator('[data-testid="platform-user-row"][data-role="PLATFORM_OWNER"]');
    const count = await rows.count();
    test.skip(count !== 1, "Only meaningful with exactly one owner.");

    const email = await rows.first().getAttribute("data-email");
    const listed = await request.get("/api/platform/users");
    expect(listed.ok()).toBeTruthy();
    const { users } = (await listed.json()) as { users: Array<{ id: string; email: string }> };
    const owner = users.find((u) => u.email === email);
    expect(owner).toBeTruthy();

    const res = await request.patch(`/api/platform/users/${owner!.id}`, {
      data: { action: "change_role", role: "PLATFORM_SUPPORT", reason: "acceptance test" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: string; refused: boolean };
    expect(body.refused).toBe(true);
    expect(body.error).toMatch(/last enabled PLATFORM_OWNER/i);
  });

  test("the tenant login form rejects a platform account", async ({ browser }) => {
    const email = process.env.E2E_PLATFORM_EMAIL;
    const password = process.env.E2E_PLATFORM_PASSWORD;
    test.skip(!email || !password, "Platform credentials not set.");

    // A clean context: the platform storageState would otherwise carry a
    // session into a test about signing in.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/login");
    await page.getByPlaceholder("you@algopbx.local").fill(email!);
    await page.getByPlaceholder("Password").fill(password!);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Stays on /login. The message is deliberately generic — telling the user
    // "that's a platform account" would confirm the existence of the
    // highest-privilege identity in the system to anyone who can type an
    // email address. The rejection is what matters, not the wording.
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/login/);

    await page.screenshot({ path: "e2e/screenshots/guardrail-cross-plane-login.png" });
    await context.close();
  });

  test("dialplan cut is absent from the billing tab", async ({ page }) => {
    await page.goto("/platform/tenants");
    const firstRow = page.getByTestId("tenant-row").first();
    test.skip((await page.getByTestId("tenant-row").count()) === 0, "No tenants seeded.");
    await firstRow.locator("a").first().click();

    await page.getByRole("tab", { name: /billing/i }).click();
    await expect(page.getByTestId("billing-actions")).toBeVisible();

    // The central assertion of this whole feature.
    const billingPanel = page.getByTestId("billing-actions");
    await expect(billingPanel.getByText(/dialplan/i)).toHaveCount(0);
    await expect(page.getByTestId("action-dialplan-cut")).toHaveCount(0);

    // And the reassurance is present where billing decisions are made.
    await expect(page.getByTestId("enforcement-rung")).toContainText(/Calls are never stopped automatically/i);

    await page.screenshot({ path: "e2e/screenshots/billing-tab-no-dialplan.png", fullPage: true });
  });

  test("dialplan cut requires the tenant slug typed exactly", async ({ page }) => {
    await page.goto("/platform/tenants");
    test.skip((await page.getByTestId("tenant-row").count()) === 0, "No tenants seeded.");

    const slug = await page.getByTestId("tenant-row").first().getAttribute("data-slug");
    await page.getByTestId("tenant-row").first().locator("a").first().click();

    await page.getByRole("tab", { name: /lifecycle/i }).click();
    const cutButton = page.getByTestId("action-dialplan-cut");
    test.skip((await cutButton.count()) === 0, "Dialplan already cut, or not an owner session.");

    await cutButton.click();

    // The dialog must state the real consequence, not a euphemism.
    const blast = page.getByTestId("blast-radius");
    await expect(blast).toContainText(/STOPS ALL CALLS/);
    await expect(blast).toContainText(/inbound and outbound/);
    await expect(blast).not.toContainText(/NOT affected/);

    // A reason alone is not enough.
    await page.getByTestId("confirm-reason").fill("acceptance test — not proceeding");
    await expect(page.getByTestId("confirm-submit")).toBeDisabled();
    await expect(page.getByTestId("confirm-blocked-reason")).toContainText(slug!);

    // A near-miss slug is not enough either.
    await page.getByTestId("confirm-typed").fill(`${slug}x`);
    await expect(page.getByTestId("confirm-submit")).toBeDisabled();

    await page.screenshot({ path: "e2e/screenshots/dialplan-cut-typed-confirmation.png" });

    // Correct slug enables it — then we deliberately close without confirming.
    await page.getByTestId("confirm-typed").fill(slug!);
    await expect(page.getByTestId("confirm-submit")).toBeEnabled();
    await page.getByRole("button", { name: /cancel/i }).click();
  });

  test("the API refuses a dialplan cut without typed confirmation", async ({ request, page }) => {
    await page.goto("/platform/tenants");
    test.skip((await page.getByTestId("tenant-row").count()) === 0, "No tenants seeded.");
    const slug = await page.getByTestId("tenant-row").first().getAttribute("data-slug");

    const listed = await request.get("/api/platform/tenants");
    const { tenants } = (await listed.json()) as { tenants: Array<{ id: string; slug: string }> };
    const tenant = tenants.find((t) => t.slug === slug)!;

    // No confirmSlug at all.
    const noConfirm = await request.post(`/api/platform/tenants/${tenant.id}/dialplan-cut`, {
      data: { reason: "acceptance test", acknowledgeOutage: true },
    });
    expect(noConfirm.status()).toBe(400);

    // Wrong confirmSlug.
    const wrongConfirm = await request.post(`/api/platform/tenants/${tenant.id}/dialplan-cut`, {
      data: { reason: "acceptance test", confirmSlug: `${slug}-wrong`, acknowledgeOutage: true },
    });
    expect(wrongConfirm.status()).toBe(400);
    expect(((await wrongConfirm.json()) as { error: string }).error).toMatch(/does not match/i);

    // Correct slug but no outage acknowledgement.
    const noAck = await request.post(`/api/platform/tenants/${tenant.id}/dialplan-cut`, {
      data: { reason: "acceptance test", confirmSlug: slug },
    });
    expect(noAck.status()).toBe(400);
  });

  test("billing actions never report a telephony effect", async ({ request, page }) => {
    await page.goto("/platform/tenants");
    test.skip((await page.getByTestId("tenant-row").count()) === 0, "No tenants seeded.");

    const listed = await request.get("/api/platform/tenants");
    const { tenants } = (await listed.json()) as { tenants: Array<{ id: string }> };
    const tenantId = tenants[0].id;

    const res = await request.post(`/api/platform/tenants/${tenantId}/suspend`, {
      data: { reason: "acceptance test — suspend" },
    });

    if (res.ok()) {
      const body = (await res.json()) as { telephonyAffected: boolean };
      expect(body.telephonyAffected).toBe(false);

      // Put it back.
      await request.post(`/api/platform/tenants/${tenantId}/suspend`, {
        data: { reason: "acceptance test — restore", unsuspend: true },
      });
    } else {
      // Already suspended or offboarded — a 409, not a failure of this rule.
      expect([409]).toContain(res.status());
    }
  });
});
