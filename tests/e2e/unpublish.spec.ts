import { test, expect } from "@playwright/test";

// Uses the seeded Toyota Hilux (a06, seller = dealer 1, live, no bids). a06 is the SPARE
// auction no other e2e spec touches (a01 is bid on by bidding.spec, a02 by discovery/realtime,
// a03 sold by buy-now); unpublish permanently reverts it and globalSetup resets the DB only
// once, so this spec (alphabetically last) runs after all others.
test("seller unpublishes a live no-bid listing back to draft", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click(); // dealer 1 owns the Hilux
  await expect(page).toHaveURL("/");
  // Let the home page's background Link prefetch (Next.js dev) settle before
  // navigating again — clicking immediately can race the in-flight prefetch
  // for /dashboard and silently drop the navigation (same race dashboard.spec.ts guards).
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");

  // Scope to the Hilux row (a My-listings row div) and unpublish it (two-step confirm).
  const hiluxRow = page.locator("div.flex.items-center.justify-between", { hasText: "2017 Toyota Hilux" });
  await hiluxRow.getByRole("button", { name: "Unpublish" }).click();
  await hiluxRow.getByRole("button", { name: "Yes" }).click();

  // It reverted to a draft: the draft-only Discard control now appears and Unpublish is gone.
  await expect(hiluxRow.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(hiluxRow.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
});
