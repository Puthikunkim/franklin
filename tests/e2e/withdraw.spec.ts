import { test, expect, type Page } from "@playwright/test";

// Two-dealer withdraw on the SPARE seeded Ford Ranger (a07, seller = Waikato Trade Cars / D2,
// starting $9,000). No other e2e spec needs a07 live, and 'withdraw.spec.ts' sorts alphabetically
// last, so cancelling a07 can't affect another spec. Dealer A (Auckland / D1) bids; the owner
// (D2) withdraws it from the dashboard → the row becomes 'cancelled'.
const A07 = "/auction/a0000000-0000-0000-0000-000000000a07";

async function loginAs(page: Page, dealerName: RegExp) {
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
}

test("a seller withdraws a live auction that has bids", async ({ page }) => {
  // Dealer A (Auckland) places a bid on the Ranger.
  await loginAs(page, /Auckland Motor Wholesale/);
  await page.goto(A07);
  await page.getByLabel("Your max bid (NZD $)").fill("11000");
  await page.getByRole("button", { name: "Place bid" }).click();
  await expect(page.getByText("Bid placed successfully.")).toBeVisible();

  // The owner (Waikato Trade Cars) withdraws it from the dashboard.
  await loginAs(page, /Waikato Trade Cars/);
  await page.waitForLoadState("networkidle"); // Next dev prefetch race guard (as dashboard.spec)
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");

  const row = page.locator("div.flex.items-center.justify-between", { hasText: "2019 Ford Ranger" });
  await row.getByRole("button", { name: "Withdraw" }).click();
  await row.getByRole("button", { name: "Yes" }).click();

  // The row now shows cancelled and the Withdraw button is gone.
  await expect(row.getByText("cancelled")).toBeVisible();
  await expect(row.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
});
