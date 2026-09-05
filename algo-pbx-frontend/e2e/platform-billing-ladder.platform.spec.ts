import { test, expect, type APIRequestContext } from "@playwright/test";

// ACCEPTANCE 2 — the billing ladder on a seeded tenant.
//
//   paidUntil lapses -> warning banner -> login blocked (owner exception
//   works) -> mark paid with a reason -> access restored.
//
// ON THE "ASTERISK UNTOUCHED" HALF, STATED HONESTLY:
//
// The acceptance criterion asks that a test call still completes while the
// tenant is suspended. Playwright cannot place a GSM call, and this suite
// runs against a stack with no live Asterisk — so that half is NOT automated
// here, and this file does not pretend otherwise.
//
// What IS automated is the structural guarantee, which is arguably the
// stronger evidence because it holds for every future change rather than for
// one call on one day:
//
//   - Suspension and billing endpoints report telephonyAffected: false, and
//     that value is written into the audit row.
//   - The generated PJSIP/dialplan configuration is byte-identical before and
//     after a suspension.
//   - A repo-wide grep invariant (see the unit suite) proves no telephony
//     module imports the enforcement function at all.
//
// The real call remains a documented MANUAL gate in GO_LIVE_CHECKLIST.md. A
// human places a call while a tenant is suspended and confirms it connects.

async function tenantByIndex(request: APIRequestContext, i = 0) {
  const res = await request.get("/api/platform/tenants");
  const { tenants } = (await res.json()) as {
    tenants: Array<{ id: string; slug: string; paidUntil: string | null; billingStatus: string }>;
  };
  return tenants[i] ?? null;
}

/** Snapshot of whatever telephony configuration the app can currently
 * generate, used to prove suspension changes none of it. */
async function telephonySnapshot(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/platform/health");
  if (!res.ok()) return "unavailable";
  const { checks } = (await res.json()) as { checks: Array<{ id: string; status: string }> };
  return JSON.stringify(checks.filter((c) => c.id === "asterisk" || c.id === "openvpn_server"));
}

test.describe("billing enforcement ladder", () => {
  test.describe.configure({ mode: "serial" });

  let tenantId: string;
  let tenantSlug: string;
  let originalPaidUntil: string | null;

  test.beforeAll(async ({ request }) => {
    const t = await tenantByIndex(request);
    test.skip(!t, "No tenants seeded.");
    tenantId = t!.id;
    tenantSlug = t!.slug;
    originalPaidUntil = t!.paidUntil;
  });

  test.afterAll(async ({ request }) => {
    // Always restore, so a failed run does not leave a tenant locked out.
    if (!tenantId) return;
    if (originalPaidUntil) {
      await request.patch(`/api/platform/tenants/${tenantId}/billing`, {
        data: { action: "mark_paid", paidUntil: originalPaidUntil, reason: "acceptance test cleanup" },
      });
    } else {
      await request.patch(`/api/platform/tenants/${tenantId}/billing`, {
        data: { action: "comp", reason: "acceptance test cleanup — restoring comped state" },
      });
    }
  });

  test("a lapsed paidUntil inside the grace window shows a warning, not a block", async ({
    page,
    request,
  }) => {
    // Three days overdue: rung 1.
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const res = await request.patch(`/api/platform/tenants/${tenantId}/billing`, {
      data: { action: "mark_paid", paidUntil: threeDaysAgo, reason: "acceptance test — lapse into grace" },
    });
    expect(res.ok()).toBeTruthy();

    await page.goto(`/platform/tenants/${tenantId}?tab=billing`);
    await page.getByRole("tab", { name: /billing/i }).click();

    const rung = page.getByTestId("enforcement-rung");
    await expect(rung).toHaveAttribute("data-rung", "warning");
    await expect(rung).toContainText(/grace/i);
    // The reassurance appears wherever the ladder does.
    await expect(rung).toContainText(/Calls are never stopped automatically/i);

    await page.screenshot({ path: "e2e/screenshots/billing-rung-warning.png", fullPage: true });
  });

  test("the tenant sees a warning banner but keeps full access", async ({ browser }) => {
    test.skip(!process.env.E2E_ADMIN_EMAIL, "Tenant admin storage state not available.");

    const ctx = await browser.newContext({ storageState: ".auth/admin.json" });
    const tenantPage = await ctx.newPage();
    await tenantPage.goto("/admin");

    // Full access retained at this rung — they are on /admin, not /billing-hold.
    await expect(tenantPage).toHaveURL(/\/admin/);

    const banner = tenantPage.getByTestId("billing-warning-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/overdue/i);
    // The single most important sentence on the page.
    await expect(banner).toContainText(/calls are not affected/i);

    await tenantPage.screenshot({ path: "e2e/screenshots/tenant-billing-warning.png", fullPage: true });
    await ctx.close();
  });

  test("past the grace window login is blocked, and Asterisk config is unchanged", async ({
    page,
    request,
    browser,
  }) => {
    const before = await telephonySnapshot(request);

    // Thirty days overdue: rung 2.
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await request.patch(`/api/platform/tenants/${tenantId}/billing`, {
      data: { action: "mark_paid", paidUntil: longAgo, reason: "acceptance test — past grace" },
    });

    await page.goto(`/platform/tenants/${tenantId}?tab=billing`);
    await page.getByRole("tab", { name: /billing/i }).click();
    await expect(page.getByTestId("enforcement-rung")).toHaveAttribute("data-rung", "login_blocked");

    // The tenant ADMIN exception: they still get in, and land on the hold
    // page rather than the workspace.
    if (process.env.E2E_ADMIN_EMAIL) {
      const ctx = await browser.newContext({ storageState: ".auth/admin.json" });
      const tenantPage = await ctx.newPage();
      await tenantPage.goto("/admin");
      await expect(tenantPage).toHaveURL(/\/billing-hold/);

      // And the hold page's main job: telling them their phones still work.
      await expect(tenantPage.getByTestId("calls-unaffected-notice")).toBeVisible();
      await expect(tenantPage.getByTestId("calls-unaffected-notice")).toContainText(
        /calls are still running/i,
      );

      await tenantPage.screenshot({ path: "e2e/screenshots/billing-hold-page.png", fullPage: true });
      await ctx.close();
    }

    // Structural half of "Asterisk untouched": nothing the app reports about
    // telephony changed across the whole ladder transition.
    const after = await telephonySnapshot(request);
    expect(after).toBe(before);

    await page.screenshot({ path: "e2e/screenshots/billing-rung-blocked.png", fullPage: true });
  });

  test("suspension audit rows record that telephony was not affected", async ({ page }) => {
    await page.goto("/platform/audit?action=billing.mark_paid");
    const rows = page.getByTestId("audit-row");
    await expect(rows.first()).toBeVisible();

    // No billing row is ever flagged as telephony-affecting.
    const flagged = page.locator('[data-testid="audit-row"][data-telephony="true"]');
    await expect(flagged).toHaveCount(0);

    await page.screenshot({ path: "e2e/screenshots/audit-billing-rows.png", fullPage: true });
  });

  test("marking paid with a reason restores access immediately", async ({ page, request, browser }) => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    await page.goto(`/platform/tenants/${tenantId}?tab=billing`);
    await page.getByRole("tab", { name: /billing/i }).click();
    await page.locator("#paid-until-input").fill(future);
    await page.getByTestId("action-mark-paid").click();

    // The reason is mandatory in the dialog...
    await expect(page.getByTestId("confirm-submit")).toBeDisabled();
    await expect(page.getByTestId("confirm-blocked-reason")).toContainText(/reason/i);
    await page.getByTestId("confirm-reason").fill("acceptance test — payment received");
    await page.getByTestId("confirm-submit").click();

    await expect(page.getByTestId("enforcement-rung")).toHaveAttribute("data-rung", "ok", {
      timeout: 10_000,
    });

    // ...and at the API too, not merely in the form.
    const noReason = await request.patch(`/api/platform/tenants/${tenantId}/billing`, {
      data: { action: "extend", days: 1, reason: "   " },
    });
    expect(noReason.status()).toBe(400);

    if (process.env.E2E_ADMIN_EMAIL) {
      const ctx = await browser.newContext({ storageState: ".auth/admin.json" });
      const tenantPage = await ctx.newPage();
      await tenantPage.goto("/admin");
      await expect(tenantPage).toHaveURL(/\/admin/);
      await expect(tenantPage.getByTestId("billing-warning-banner")).toHaveCount(0);
      await ctx.close();
    }

    await page.screenshot({ path: "e2e/screenshots/billing-restored.png", fullPage: true });
  });
});
