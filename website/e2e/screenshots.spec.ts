import { test, expect } from "@playwright/test";

const pages = ["/", "/terms/", "/privacy/", "/docs/"];

for (const path of pages) {
  for (const theme of ["light", "dark"] as const) {
    test(`${path} renders (${theme})`, async ({ page }) => {
      await page.goto(path);
      await page.evaluate((t) => {
        localStorage.setItem("saharatechs-theme-mode", t);
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      await page.reload();
      await expect(page.locator("body")).toBeVisible();
      await page.screenshot({
        path: `e2e/screenshots/${path.replace(/\//g, "_") || "home"}-${theme}.png`,
        fullPage: true,
      });
    });
  }
}

test("no horizontal scroll at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
});

test("internal links resolve", async ({ page, request }) => {
  await page.goto("/");
  const hrefs = await page.$$eval("a[href^='/']", (as) => as.map((a) => a.getAttribute("href")!));
  const unique = [...new Set(hrefs)];
  for (const href of unique) {
    const res = await request.get(href);
    expect(res.status(), href).toBeLessThan(400);
  }
});
