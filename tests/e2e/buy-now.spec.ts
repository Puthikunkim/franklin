import { test, expect } from "@playwright/test";

// Buys the Honda CR-V (a03, seller = dealer 3) — a SPARE seeded auction no other
// e2e spec needs to stay live. buy-now permanently sells it and globalSetup resets
// the DB only once, so using a01 (bidding) / a02 (discovery, realtime) would break
// those specs by execution order.
test("dealer buys a live auction outright with Buy now", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click(); // dealer 1 (buyer)
  await expect(page).toHaveURL("/");

  // Narrow to the CR-V and open it. FilterBar debounces the search box 300ms
  // before pushing ?q=Honda via router.replace; wait for that URL update (so
  // the debounce has actually fired) and for the resulting RSC fetch to settle
  // before clicking — otherwise the click can race the in-flight search
  // navigation and get silently dropped (conceptually the same class of Next.js
  // dev-navigation race that dashboard.spec.ts guards with a networkidle wait).
  await page.getByPlaceholder("Search make, model, variant").fill("Honda");
  await expect(page).toHaveURL(/[?&]q=Honda/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { name: /Honda CR-V/ }).click();
  await expect(page).toHaveURL(/\/auction\//);

  // Buy it now (two-step confirm).
  await page.getByRole("button", { name: /Buy now for/ }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  // Lands on the settlement page showing the sale + fees. This is the first
  // navigation to /won/[id] in the whole e2e run, so Next.js dev (Turbopack)
  // compiles the route on demand — measured ~14s cold — well past the default
  // 5s assertion timeout. Give this one assertion more time; the condition
  // checked is unchanged.
  await expect(page).toHaveURL(/\/won\//, { timeout: 20000 });
  await expect(page.getByRole("heading", { name: "Settlement arranged" })).toBeVisible();
  await expect(page.getByText("Auction sold")).toBeVisible();
  await expect(page.getByText("$11,000")).toBeVisible(); // buy_now_price sale price
  await expect(page.getByText("Buyer fee")).toBeVisible();
  // exact:true so it matches the buyer fee ("$20") and not the seller fee ("$200").
  await expect(page.getByText("$20", { exact: true })).toBeVisible(); // default buyer_fee = 2000c
});
