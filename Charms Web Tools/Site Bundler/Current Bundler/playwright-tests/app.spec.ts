import { expect, test } from "@playwright/test";

test("loads the workspace shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Bundler Station")).toBeVisible();
  await expect(page.locator("#assetCount")).toHaveText("0");
});
