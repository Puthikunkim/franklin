import { test, expect } from "@playwright/test";

test("dealer can search, watch, and manage their watchlist", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click();
  await expect(page).toHaveURL("/");

  // Search narrows the grid to the single matching live auction (Mazda CX-5),
  // and the non-matching Toyota Corolla card disappears.
  await page.getByPlaceholder("Search make, model, variant").fill("Mazda");
  await expect(page.getByRole("heading", { name: /Mazda CX-5/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Toyota Corolla/ })).toHaveCount(0);

  // Watch it from the card; the button flips to Unwatch.
  await page.getByRole("button", { name: "Watch" }).click();
  await expect(page.getByRole("button", { name: "Unwatch" })).toBeVisible();

  // It shows up under "Watching" on the dashboard.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");
  await expect(page.getByText("2020 Mazda CX-5")).toBeVisible();

  // Open the auction from the Watching row and unwatch it.
  await page.getByText("2020 Mazda CX-5").click();
  await expect(page).toHaveURL(/\/auction\//);
  await page.getByRole("button", { name: "Unwatch" }).click();
  await expect(page.getByRole("button", { name: "Watch" })).toBeVisible();

  // Back on the dashboard, "Watching" is empty again.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("2020 Mazda CX-5")).toHaveCount(0);
  await expect(page.getByText("You're not watching any auctions.")).toBeVisible();
});
