import { test, expect } from "@playwright/test";

test("dealer sees their activity and can discard a draft", async ({ page }) => {
  await page.goto("/login");
  // Log in as the dealer who owns the seeded draft (Auckland Motor Wholesale = dealer 1).
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");
  await expect(page.getByRole("heading", { name: "My activity" })).toBeVisible();

  // The seeded Nissan Navara draft appears under My listings with a Draft status + Discard.
  const draftRow = page.locator("div", { hasText: "2022 Nissan Navara" }).last();
  await expect(page.getByText("2022 Nissan Navara")).toBeVisible();

  // Discard it (two-step confirm) and confirm it disappears.
  await page.getByRole("button", { name: "Discard" }).first().click();
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(page.getByText("2022 Nissan Navara")).toHaveCount(0);
});
