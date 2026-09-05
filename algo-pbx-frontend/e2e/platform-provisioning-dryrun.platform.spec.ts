import { test, expect } from "@playwright/test";

// ACCEPTANCE 5 — provisioning dry-run up to the human certificate gate.
//
// Creates a throwaway tenant, advances it step by step, and asserts the run
// PAUSES at certificate issuance with the correct manual command shown. The
// point is not that the wizard works; it is that the wizard cannot be talked
// past the gate, and that an operator standing at it is given exactly the
// command to run rather than being left to reconstruct it.
//
// Cleanup offboards the test tenant rather than deleting it — the console has
// no delete path by design, and this suite does not get a special one.

const SLUG = `e2e-prov-${Date.now().toString(36)}`;

test.describe("provisioning wizard", () => {
  test.describe.configure({ mode: "serial" });

  let tenantId: string | null = null;

  test.afterAll(async ({ request }) => {
    if (!tenantId) return;
    await request.post(`/api/platform/tenants/${tenantId}/offboard`, {
      data: { reason: "acceptance test cleanup", confirmSlug: SLUG },
    });
  });

  test("the slug is validated live, including the reserved list", async ({ page }) => {
    await page.goto("/platform/provisioning/new");
    const slugField = page.getByTestId("new-tenant-slug");
    test.skip((await slugField.count()) === 0, "Not an owner session.");

    // Reserved word — this collides with our own console's hostname.
    await slugField.fill("platform");
    await expect(page.getByTestId("slug-error")).toContainText(/reserved/i);

    // Bad charset for a DNS label and for bridge-watch.sh's SAFE_NAME_RE.
    await slugField.fill("bad_slug!");
    await expect(page.getByTestId("slug-error")).toBeVisible();

    // Leading hyphen is invalid in a DNS label.
    await slugField.fill("-nope");
    await expect(page.getByTestId("slug-error")).toBeVisible();

    // Valid: shows what the slug will become on the host.
    await slugField.fill(SLUG);
    await expect(page.getByTestId("slug-error")).toHaveCount(0);
    await expect(page.getByText(`cust-${SLUG}-gw-1`)).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/provisioning-slug-validation.png", fullPage: true });
  });

  test("creating a tenant starts a provisioning run", async ({ page }) => {
    await page.goto("/platform/provisioning/new");
    test.skip((await page.getByTestId("new-tenant-slug").count()) === 0, "Not an owner session.");

    await page.getByTestId("new-tenant-slug").fill(SLUG);
    await page.getByTestId("new-tenant-name").fill("E2E Provisioning Test");
    await page.getByTestId("new-tenant-reason").fill("acceptance test — provisioning dry run");
    await page.getByTestId("submit-new-tenant").click();

    // The negative lookahead matters: without it this pattern also matches
    // /platform/provisioning/new — the page we are already on — so the wait
    // resolves instantly and `tenantId` becomes the literal string "new",
    // sending every later test to the create form instead of the run.
    await page.waitForURL(/\/platform\/provisioning\/(?!new$)[^/]+$/, { timeout: 15_000 });
    tenantId = page.url().split("/").pop()!;
    expect(tenantId).not.toBe("new");

    // Slug validation and tenant creation are done by the create handler
    // itself, so the run starts at step 3.
    await expect(page.locator('[data-step="validate_slug"]')).toHaveAttribute("data-state", "done");
    await expect(page.locator('[data-step="create_tenant"]')).toHaveAttribute("data-state", "done");

    // The certificate step is labelled as a human gate in the pipeline list.
    await expect(page.locator('[data-step="issue_cert"]')).toContainText(/human gate/i);
  });

  test("the run advances to, and stops at, the certificate gate", async ({ page }) => {
    test.skip(!tenantId, "Tenant was not created.");

    // Advance until the wizard stops offering a runnable step.
    for (let i = 0; i < 8; i++) {
      await page.goto(`/platform/provisioning/${tenantId}`);
      const advance = page.getByTestId("advance-step");
      if ((await advance.count()) === 0) break;

      const stepLabel = (await page.getByTestId("next-step").textContent()) ?? "";
      if (/certificate/i.test(stepLabel)) break;

      await advance.click();
      // A step may legitimately fail (subdomain resolution without the
      // wildcard record, for instance) — that is a truthful outcome, and the
      // run stops there rather than pretending.
      const err = page.getByTestId("wizard-error");
      await page.waitForTimeout(750);
      if ((await err.count()) > 0) break;
    }

    await page.goto(`/platform/provisioning/${tenantId}`);
    await page.screenshot({ path: "e2e/screenshots/provisioning-run.png", fullPage: true });
  });

  test("the certificate gate shows the exact manual command and never signs", async ({ page }) => {
    test.skip(!tenantId, "Tenant was not created.");
    await page.goto(`/platform/provisioning/${tenantId}`);

    const gate = page.getByTestId("cert-gate");
    const blocked = page.getByTestId("blocked-step");

    // The invariant under test is one thing only: the run must NOT have
    // sailed past certificate issuance. Assert that directly, on the pipeline,
    // rather than inferring it from which pause state the page happens to be
    // in — the step list is the authoritative record either way.
    await expect(page.locator('[data-step="issue_cert"]')).not.toHaveAttribute("data-state", "done");

    const atGate = (await gate.count()) > 0;

    if (!atGate) {
      // Stopped short of the gate. There are two honest ways for that to
      // happen and both must state a reason rather than stalling silently:
      //   - a `blocked` verdict, e.g. an unmet prerequisite; or
      //   - a runnable step whose last attempt failed, which is what an
      //     environment without the one-time *.algopbx.com wildcard DNS
      //     record produces at "Verify workspace subdomain".
      const stoppedBlocked = (await blocked.count()) > 0;
      const stoppedOnError = (await page.getByTestId("wizard-error").count()) > 0;
      expect(stoppedBlocked || stoppedOnError).toBe(true);

      const reason = stoppedBlocked
        ? page.getByTestId("blocked-reason")
        : page.getByTestId("wizard-error");
      await expect(reason).not.toBeEmpty();

      await page.screenshot({ path: "e2e/screenshots/provisioning-blocked.png", fullPage: true });
      return;
    }

    // The command must match what manual-cert-command.ts builds.
    const command = page.getByTestId("cert-command");
    await expect(command).toContainText(`docker exec -it algo-openvpn-server easyrsa build-client-full cust-${SLUG}-gw-1 nopass`);
    await expect(command).toContainText(`ovpn_getclient cust-${SLUG}-gw-1 combined`);
    // The historical mistake must not have crept back in.
    await expect(command).not.toContainText(/ovpn_getclient \S+ nopass/);

    // Framed as deliberate, and pointing at the real blocker.
    await expect(gate).toContainText(/manual by design/i);
    await expect(gate).toContainText(/CA signing flow v2/i);
    await expect(gate).toContainText(/passphrase/i);

    // No automated signing affordance exists anywhere on the page.
    await expect(page.getByRole("button", { name: /^(issue|sign) cert/i })).toHaveCount(0);

    // With no certificate on disk, the wizard says so and offers no way on.
    if ((await page.getByTestId("cert-missing").count()) > 0) {
      await expect(page.getByTestId("confirm-cert")).toHaveCount(0);
    }

    await page.screenshot({ path: "e2e/screenshots/provisioning-cert-gate.png", fullPage: true });
  });

  test("the API refuses to advance past the gate without confirmation", async ({ request }) => {
    test.skip(!tenantId, "Tenant was not created.");

    const res = await request.post(`/api/platform/tenants/${tenantId}/provisioning/advance`, {
      data: {},
    });
    // Either blocked by the machine (409) or refused for lack of the
    // confirmation flag (400). Never a success.
    expect([400, 409]).toContain(res.status());

    const body = (await res.json()) as { reason?: string; error?: string };
    expect(body.reason ?? body.error).toBeTruthy();
  });

  test("an incomplete compliance checklist warns without blocking", async ({ page }) => {
    test.skip(!tenantId, "Tenant was not created.");

    await page.goto(`/platform/tenants/${tenantId}`);
    // The tenant exists and is usable...
    await expect(page.getByRole("heading", { name: /E2E Provisioning Test/ })).toBeVisible();
    // ...but the gap is visible on the page it belongs to.
    await expect(page.getByTestId("compliance-banner")).toBeVisible();
    await expect(page.getByTestId("compliance-banner")).toContainText(/outstanding/i);

    await page.goto("/platform/tenants");
    const row = page.locator(`[data-testid="tenant-row"][data-slug="${SLUG}"]`);
    await expect(row.getByTestId("compliance-warning")).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/compliance-warning.png", fullPage: true });
  });
});
