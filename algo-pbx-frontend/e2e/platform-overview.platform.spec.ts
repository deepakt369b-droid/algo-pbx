import { test, expect } from "@playwright/test";

// ACCEPTANCE 4 — the overview's numbers match the database, with no mock data.
//
// Verified by comparing what the page RENDERS against what the API REPORTS in
// the same run, rather than by opening a second database connection from the
// test process. That keeps the check honest without giving the test suite
// production credentials, and it catches the failure that actually matters:
// a page that displays a hardcoded or stale figure while the data says
// otherwise.

interface Overview {
  statusCounts: { trial: number; active: number; pastDue: number; suspended: number; offboarded: number; total: number };
  seats: { sold: number; provisioned: number; unused: number };
  mrr: { totalAed: number; bookkeepingOnly: boolean; unpricedPlans: string[] };
  attention: Array<{ id: string; severity: string; href: string; title: string }>;
}

test.describe("platform overview", () => {
  test("tenant status counts match the API", async ({ page, request }) => {
    const res = await request.get("/api/platform/overview");
    expect(res.ok()).toBeTruthy();
    const data = (await res.json()) as Overview;

    await page.goto("/platform");
    const counts = page.getByTestId("tenant-status-counts");
    await expect(counts).toBeVisible();

    const text = (await counts.textContent()) ?? "";
    // Each figure appears exactly as the API reported it.
    expect(text).toContain(String(data.statusCounts.trial));
    expect(text).toContain(String(data.statusCounts.active));
    expect(text).toContain(String(data.statusCounts.pastDue));
    expect(text).toContain(String(data.statusCounts.suspended));

    await page.screenshot({ path: "e2e/screenshots/overview.png", fullPage: true });
  });

  test("seat figures match, and are real Extension counts", async ({ page, request }) => {
    const data = (await (await request.get("/api/platform/overview")).json()) as Overview;

    await page.goto("/platform");
    const seats = page.getByTestId("seat-summary");
    await expect(seats).toContainText(String(data.seats.sold));
    await expect(seats).toContainText(String(data.seats.provisioned));

    // Cross-check against the tenant list's own used/allocated column, which
    // is computed independently by a different query.
    await page.goto("/platform/tenants");
    const rows = page.getByTestId("tenant-row");
    let provisionedFromList = 0;
    for (let i = 0; i < (await rows.count()); i++) {
      const cells = rows.nth(i).locator("td");
      const seatText = (await cells.nth(3).textContent()) ?? "0/0";
      provisionedFromList += Number(seatText.split("/")[0].trim() || 0);
    }
    // The overview excludes offboarded tenants; the list here includes them
    // unless filtered, so the overview can only be less than or equal.
    expect(data.seats.provisioned).toBeLessThanOrEqual(provisionedFromList);
  });

  test("MRR matches and is labelled as bookkeeping, not revenue", async ({ page, request }) => {
    const data = (await (await request.get("/api/platform/overview")).json()) as Overview;
    expect(data.mrr.bookkeepingOnly).toBe(true);

    await page.goto("/platform");
    await expect(page.getByText(`AED ${data.mrr.totalAed.toLocaleString("en-AE")}`)).toBeVisible();

    // The caption is not decoration: an unqualified number on an owner
    // dashboard will be read as real revenue.
    const caption = page.getByTestId("mrr-caption");
    await expect(caption).toContainText(/bookkeeping estimate/i);
    await expect(caption).toContainText(/no payment processor is connected/i);
  });

  test("every attention item deep-links to its fix", async ({ page, request }) => {
    const data = (await (await request.get("/api/platform/overview")).json()) as Overview;

    await page.goto("/platform");

    if (data.attention.length === 0) {
      await expect(page.getByTestId("attention-empty")).toBeVisible();
      return;
    }

    const items = page.getByTestId("attention-queue").locator("li a");
    await expect(items).toHaveCount(data.attention.length);

    for (let i = 0; i < (await items.count()); i++) {
      const href = await items.nth(i).getAttribute("href");
      expect(href, "every attention item must link somewhere actionable").toBeTruthy();
      expect(href!.startsWith("/platform/")).toBe(true);
    }

    // And the first one actually resolves rather than 404ing.
    const firstHref = await items.first().getAttribute("href");
    const resolved = await page.goto(firstHref!);
    expect(resolved?.status()).toBeLessThan(400);

    await page.screenshot({ path: "e2e/screenshots/attention-queue-target.png", fullPage: true });
  });

  test("the health strip reports each dependency with a check time", async ({ page, request }) => {
    const res = await request.get("/api/platform/health");
    expect(res.ok()).toBeTruthy();
    const health = (await res.json()) as {
      checks: Array<{ id: string; status: string; checkedAt: string }>;
    };

    await page.goto("/platform");
    const strip = page.getByTestId("health-strip");
    await expect(strip).toBeVisible();

    for (const check of health.checks) {
      const row = strip.locator(`[data-check="${check.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-status", check.status);
      await expect(row).toContainText(/Checked /);
    }

    // The two honest-unknowns must never render as healthy.
    const headscale = health.checks.find((c) => c.id === "headscale");
    expect(headscale?.status, "Headscale cannot be checked from this container").toBe("unknown");

    await page.screenshot({ path: "e2e/screenshots/health-strip.png", fullPage: true });
  });
});
