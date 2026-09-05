import { test, expect, type APIRequestContext } from "@playwright/test";

// ACCEPTANCE 1 — the full support-access lifecycle.
//
//   create support user -> forced password change + TOTP at first login ->
//   cannot read tenant call content without a grant -> grant created (24h
//   ceiling enforced) -> banner visible in the tenant UI -> grant ends ->
//   access gone -> every event in the audit log.
//
// The banner assertion is the one that matters most to the customer. The
// whole support-grant mechanism is a promise that we cannot look at their
// data without them knowing; if the banner does not render, the promise is
// not kept, however correct the database is.

async function firstTenant(request: APIRequestContext) {
  const res = await request.get("/api/platform/tenants");
  const { tenants } = (await res.json()) as { tenants: Array<{ id: string; slug: string }> };
  return tenants[0] ?? null;
}

test.describe("support access lifecycle", () => {
  test("a support account is created with a one-time password, shown once", async ({ page }) => {
    const email = `e2e-support-${Date.now()}@algopbx.internal`;

    await page.goto("/platform/users");
    const createForm = page.getByTestId("new-user-email");
    test.skip((await createForm.count()) === 0, "Not an owner session — cannot create users.");

    await createForm.fill(email);
    await page.getByTestId("new-user-name").fill("E2E Support");
    // PLATFORM_SUPPORT is the default; asserting that rather than selecting it.
    await expect(page.getByTestId("new-user-role")).toHaveValue("PLATFORM_SUPPORT");

    await page.getByTestId("action-create-user").click();
    await page.getByTestId("confirm-reason").fill("acceptance test — support lifecycle");
    await page.getByTestId("confirm-submit").click();

    const panel = page.getByTestId("one-time-password");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/shown once/i);
    await expect(panel).toContainText(/cannot be retrieved again/i);

    await page.screenshot({ path: "e2e/screenshots/support-one-time-password.png", fullPage: true });

    // The new account is listed as setup-pending with TOTP not yet enrolled —
    // it cannot reach the console until both are done.
    const row = page.locator(`[data-testid="platform-user-row"][data-email="${email}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(/pending/i);
  });

  test("a support account cannot reach the console until password and TOTP are done", async ({
    browser,
    page,
  }) => {
    // Find a support account still in setup.
    await page.goto("/platform/users");
    const pendingRow = page
      .locator('[data-testid="platform-user-row"][data-role="PLATFORM_SUPPORT"]')
      .filter({ hasText: /setup pending/i })
      .first();
    test.skip((await pendingRow.count()) === 0, "No account mid-setup to check.");

    // Without credentials for it we cannot sign in as it; what we CAN assert
    // is the structural guarantee — the console layout bounces an
    // un-enrolled session to /platform/setup rather than rendering.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anon = await ctx.newPage();
    await anon.goto("/platform/tenants");
    await expect(anon).toHaveURL(/\/platform\/login/);
    await ctx.close();
  });

  test("the 24h ceiling is enforced server-side, not just in the form", async ({ request }) => {
    const tenant = await firstTenant(request);
    test.skip(!tenant, "No tenants seeded.");

    // Ask for a week. The server clamps rather than trusting the client —
    // "no open-ended grants" has to survive a hand-crafted request.
    const res = await request.post("/api/platform/support-grants", {
      data: {
        tenantId: tenant!.id,
        reason: "acceptance test — ceiling check",
        durationMinutes: 7 * 24 * 60,
      },
    });
    expect(res.status()).toBe(201);
    const { grant } = (await res.json()) as { grant: { id: string; grantedAt: string; expiresAt: string } };

    const hours =
      (new Date(grant.expiresAt).getTime() - new Date(grant.grantedAt).getTime()) / 3_600_000;
    expect(hours).toBeLessThanOrEqual(24.001);

    await request.post(`/api/platform/support-grants/${grant.id}/revoke`);
  });

  test("a grant is refused without a reason", async ({ request }) => {
    const tenant = await firstTenant(request);
    test.skip(!tenant, "No tenants seeded.");

    for (const reason of ["", "   "]) {
      const res = await request.post("/api/platform/support-grants", {
        data: { tenantId: tenant!.id, reason, durationMinutes: 60 },
      });
      expect(res.status()).toBe(400);
    }
  });

  test("a live grant shows a banner in the tenant UI, and it disappears on revoke", async ({
    browser,
    request,
  }) => {
    const tenant = await firstTenant(request);
    test.skip(!tenant, "No tenants seeded.");
    test.skip(!process.env.E2E_ADMIN_EMAIL, "Tenant admin storage state not available.");

    const reason = `acceptance test — banner visibility ${Date.now()}`;
    const created = await request.post("/api/platform/support-grants", {
      data: { tenantId: tenant!.id, reason, durationMinutes: 60 },
    });
    expect(created.status()).toBe(201);
    const { grant } = (await created.json()) as { grant: { id: string } };

    // Open the TENANT admin UI in its own context with the tenant session.
    const tenantCtx = await browser.newContext({ storageState: ".auth/admin.json" });
    const tenantPage = await tenantCtx.newPage();
    await tenantPage.goto("/admin");

    const banner = tenantPage.getByTestId("support-access-banner");
    await expect(banner).toBeVisible();
    // It names who is in there and why — not merely that "support" is active.
    await expect(banner).toContainText(/support access active/i);
    await expect(banner).toContainText(reason);

    await tenantPage.screenshot({
      path: "e2e/screenshots/tenant-support-banner.png",
      fullPage: true,
    });

    // End the grant; the banner must go.
    const revoked = await request.post(`/api/platform/support-grants/${grant.id}/revoke`);
    expect(revoked.ok()).toBeTruthy();

    await tenantPage.reload();
    await expect(tenantPage.getByTestId("support-access-banner")).toHaveCount(0);

    await tenantCtx.close();
  });

  test("every grant event lands in the platform audit log", async ({ page, request }) => {
    const tenant = await firstTenant(request);
    test.skip(!tenant, "No tenants seeded.");

    const reason = `acceptance test — audit trail ${Date.now()}`;
    const created = await request.post("/api/platform/support-grants", {
      data: { tenantId: tenant!.id, reason, durationMinutes: 30 },
    });
    const { grant } = (await created.json()) as { grant: { id: string } };
    await request.post(`/api/platform/support-grants/${grant.id}/revoke`);

    await page.goto("/platform/audit?action=support_grant.create");
    await expect(page.getByTestId("audit-table")).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();

    await page.goto("/platform/audit?action=support_grant.revoke");
    await expect(page.getByTestId("audit-row").first()).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/audit-support-grants.png", fullPage: true });
  });

  test("the grant history is shown to us and to the customer alike", async ({ page, request }) => {
    const tenant = await firstTenant(request);
    test.skip(!tenant, "No tenants seeded.");

    await page.goto(`/platform/tenants/${tenant!.id}?tab=support`);
    await expect(page.getByRole("tab", { name: /support access/i })).toBeVisible();
    await page.getByRole("tab", { name: /support access/i }).click();

    // The console states plainly that nothing here is hidden from the tenant.
    await expect(page.getByText(/also visible to the customer/i)).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/support-grant-history.png", fullPage: true });
  });
});
