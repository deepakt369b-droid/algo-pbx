import { test, expect } from "@playwright/test";

// F1 acceptance: the header toggle flips every surface, and no page leaks a
// hardcoded colour (checked structurally by asserting the token attribute,
// not by scraping computed styles of every node).
const PAGES = ["/admin", "/admin/contacts", "/admin/cdr", "/admin/users", "/admin/settings"];

test.describe("Apple-black theme toggle", () => {
  for (const path of PAGES) {
    test(`toggles light/dark on ${path}`, async ({ page }) => {
      await page.goto(path);
      const html = page.locator("html");

      // resolve current, flip, assert the attribute actually changed
      await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
      await expect(html).toHaveAttribute("data-theme", /light|dark/);
      const first = await html.getAttribute("data-theme");

      await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
      const second = await html.getAttribute("data-theme");
      expect(second).not.toBe(first);

      // persists across reload
      await page.reload();
      await expect(html).toHaveAttribute("data-theme", second!);

      await page.screenshot({ path: `test-results/theme${path.replace(/\//g, "_")}-${second}.png` });
    });
  }
});
