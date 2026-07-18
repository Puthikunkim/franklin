import { test, expect, type Page } from "@playwright/test";

// Uses a DEDICATED already-sold seed auction (b01, seller = Waikato Trade Cars / D2,
// winner = Auckland Motor Wholesale / D1) that no other spec touches. Sold auctions do
// not appear in the live grid, so this cannot affect discovery/other counts.
const B01 = "/auction/b0000000-0000-0000-0000-000000000b01";
const D2_PROFILE = "/dealer/22222222-2222-2222-2222-222222222222";

async function loginAs(page: Page, dealerName: RegExp) {
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
}

test("both parties rate a sold deal and the reputation reveals on the profile", async ({ page }) => {
  // Buyer (Auckland / D1) rates the seller.
  await loginAs(page, /Auckland Motor Wholesale/);
  await page.goto(B01);
  await page.getByRole("button", { name: "Rate 5 stars" }).click();
  await page.getByPlaceholder("Optional note (how did the deal go?)").fill("Exactly as graded, quick settlement");
  await page.getByRole("button", { name: "Submit rating" }).click();
  await expect(page.getByText(/stays hidden until the other dealer/i)).toBeVisible();

  // Seller (Waikato / D2) rates the buyer — second rating reveals both.
  await loginAs(page, /Waikato Trade Cars/);
  await page.goto(B01);
  await page.getByRole("button", { name: "Rate 4 stars" }).click();
  await page.getByRole("button", { name: "Submit rating" }).click();
  await expect(page.getByText("They rated")).toBeVisible();

  // The seller's profile now shows an "As seller" score and the buyer's review.
  await page.goto(D2_PROFILE);
  await expect(page.getByText(/As seller ★ 5\.0 \(1\)/)).toBeVisible();
  await expect(page.getByText("Exactly as graded, quick settlement")).toBeVisible();
});
