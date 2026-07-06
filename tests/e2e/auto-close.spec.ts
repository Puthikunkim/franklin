import { test, expect } from "@playwright/test";
import { admin } from "../helpers/db";

// Prove the render-time sweep: force the SPARE a09 (Volkswagen Golf, seller D4 — no other e2e
// spec needs it live) to expire, then load the home grid and assert it's gone (the home-render
// close_expired_auctions() closed it). a09 has no bids → closes to 'passed' (no settlement, no
// notifications), so no cross-spec pollution. This spec sorts alphabetically FIRST, so it runs
// right after globalSetup's reset while a09 is still freshly live.
const A09 = "a0000000-0000-0000-0000-000000000a09";

test("an expired auction is auto-closed and drops off the live grid on load", async ({ page }) => {
  // Expire a09 via the service-role client (mirrors how global-setup manages DB state).
  const { error } = await admin.rpc("test_set_end_in_seconds", { p_auction_id: A09, p_seconds: -1 });
  expect(error).toBeNull();

  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click();
  await expect(page).toHaveURL("/");

  // The home render swept expired auctions before querying the grid, so the Golf is absent.
  await expect(page.getByRole("heading", { name: /Volkswagen Golf/ })).toHaveCount(0);
});
