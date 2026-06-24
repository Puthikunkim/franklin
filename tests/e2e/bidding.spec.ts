import { test, expect } from "@playwright/test";

// Anchor auction seeded in supabase/seed.sql:
//   id: a0000000-0000-0000-0000-000000000a01
//   starting_price: $6000, reserve_price: $7500
// We bid $9000 — comfortably above reserve — to guarantee a "Bid placed successfully." message.
const ANCHOR_AUCTION_URL = "/auction/a0000000-0000-0000-0000-000000000a01";

test("dealer logs in, opens an auction, and places a bid", async ({ page }) => {
  // ── 1. Log in ──────────────────────────────────────────────────────────────
  // login/page.tsx renders a <form> with one <button> per dealer (name="id", value=dealer_id).
  // Text inside is "{business_name} · {region}".
  // We click the first dealer button to pick any dealer.
  await page.goto("/login");
  await page.getByRole("button").first().click();

  // Should redirect to home after picking a dealer.
  await expect(page).toHaveURL("/");

  // ── 2. Assert the live-auctions grid is visible ────────────────────────────
  // page.tsx renders <h1>Live auctions</h1> and a grid of <AuctionCard> links.
  await expect(page.getByRole("heading", { name: "Live auctions" })).toBeVisible();

  // ── 3. Navigate directly to the seeded anchor auction ─────────────────────
  // Avoids grid-ordering flakiness. Auction detail page renders <BidPanel>.
  await page.goto(ANCHOR_AUCTION_URL);

  // ── 4. Place a bid ─────────────────────────────────────────────────────────
  // BidPanel.tsx:
  //   <label htmlFor="max-bid">Your max bid (NZD $)</label>
  //   <input id="max-bid" placeholder="e.g. 12500" … />
  //   <button onClick={placeBid}>Place bid</button>
  // On success, sets msg = "Bid placed successfully."
  await page.getByLabel("Your max bid (NZD $)").fill("9000");
  await page.getByRole("button", { name: "Place bid" }).click();

  // ── 5. Assert success ──────────────────────────────────────────────────────
  await expect(page.getByText("Bid placed successfully.")).toBeVisible();
});
