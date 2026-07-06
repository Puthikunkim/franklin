import { test, expect, type Page } from "@playwright/test";

// Two-dealer outbid on the SPARE seeded Nissan Leaf (a05, seller = BayCity / dealer 5). No
// other e2e spec touches a05, and globalSetup resets the DB only once. Dealer 1 (Auckland)
// takes the lead, dealer 2 (Waikato) outbids → dealer 1 gets a stored 'outbid' notification.
// Before this spec runs, dealer 1 has zero notifications (bidding uses a01, buy-now's sold
// goes to a03's seller D3, discovery/dashboard create none), so the badge is deterministically 1.
const LEAF = "/auction/a0000000-0000-0000-0000-000000000a05";

async function loginAs(page: Page, dealerName: RegExp) {
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
}

async function placeBid(page: Page, dollars: string) {
  await page.goto(LEAF);
  await page.getByLabel("Your max bid (NZD $)").fill(dollars);
  await page.getByRole("button", { name: "Place bid" }).click();
  await expect(page.getByText("Bid placed successfully.")).toBeVisible();
}

test("an outbid dealer is notified, and viewing notifications clears the badge", async ({ page }) => {
  // Dealer 1 leads (max $15,000; opens at the $14,000 starting price).
  await loginAs(page, /Auckland Motor Wholesale/);
  await placeBid(page, "15000");

  // Dealer 2 outbids with a higher max, displacing dealer 1.
  await loginAs(page, /Waikato Trade Cars/);
  await placeBid(page, "16000");

  // Back as dealer 1: the header shows a single unread notification.
  await loginAs(page, /Auckland Motor Wholesale/);
  await expect(page.getByRole("link", { name: "Notifications (1 unread)" })).toBeVisible();

  // Let the home page's background Link prefetch settle before navigating (Next dev race
  // guard, as in dashboard.spec/unpublish.spec).
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /Notifications/ }).click();
  // First hit to /notifications compiles the route on demand in dev (cold) — allow extra time.
  await expect(page).toHaveURL("/notifications", { timeout: 20000 });
  await expect(page.getByText("You were outbid on 2022 Nissan Leaf")).toBeVisible({ timeout: 20000 });

  // Viewing marked it read: on the next navigation the unread badge is gone.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /unread/ })).toHaveCount(0);
});
