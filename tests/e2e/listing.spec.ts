import { test, expect } from "@playwright/test";

const R2_READY = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET);

test("dealer creates a draft, previews it, and publishes it live", async ({ page }) => {
  test.skip(!R2_READY, "R2 not configured — skipping the photo-dependent create flow");

  await page.goto("/login");
  await page.getByRole("button").first().click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Sell a vehicle" }).click();
  await expect(page).toHaveURL("/sell");

  await page.getByLabel("Make").fill("Toyota");
  await page.getByLabel("Model").fill("Hilux");
  await page.getByLabel("Year").fill("2021");
  await page.getByLabel("Odometer (km)").fill("40000");
  await page.getByLabel("Starting ($)").fill("10000");
  await page.getByLabel("Reserve ($)").fill("12000");
  const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16);
  await page.getByLabel("Auction ends").fill(inTwoDays);

  // Upload a small generated image.
  await page.setInputFiles('input[type="file"]', {
    name: "car.png", mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100", "hex"),
  });
  await expect(page.locator('img[alt=""]')).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft — not yet live")).toBeVisible();

  await page.getByRole("button", { name: "Publish auction" }).click();
  await expect(page.getByRole("button", { name: "Place bid" })).toBeVisible({ timeout: 8000 });
});
