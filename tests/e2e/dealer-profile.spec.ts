import { test, expect } from "@playwright/test";

// A buyer (Waikato Trade Cars / D2) opens the seeded anchor auction a01 (Toyota Corolla,
// seller = Auckland Motor Wholesale / D1), clicks the seller to reach their profile, and
// verifies the trust header + a live listing. Read-only — mutates no auction state, so this
// spec is order-independent.
const A01 = "/auction/a0000000-0000-0000-0000-000000000a01";

test("a buyer opens a seller's profile from an auction and sees their trust info and listings", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Waikato Trade Cars/ }).click(); // a non-seller viewer
  await expect(page).toHaveURL("/");

  await page.goto(A01);
  // Let the auction page's background Link prefetch settle before clicking (Next dev race guard).
  await page.waitForLoadState("networkidle");
  // The seller badge in the Seller section links to /dealer/[id].
  await page.getByRole("link", { name: /Auckland Motor Wholesale/ }).click();
  // First hit to /dealer/[id] is a cold Turbopack compile in dev — allow extra time.
  await expect(page).toHaveURL(/\/dealer\//, { timeout: 20000 });

  // Trust header: business name heading + verified indicator.
  await expect(page.getByRole("heading", { name: "Auckland Motor Wholesale" })).toBeVisible({ timeout: 20000 });
  // Live listings: the dealer's seeded Corolla appears as a card.
  await expect(page.getByRole("heading", { name: /Toyota Corolla/ })).toBeVisible();
});
