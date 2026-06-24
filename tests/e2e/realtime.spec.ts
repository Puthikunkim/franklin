import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// The hero capability: two dealers on the same auction in separate browsers, and a
// bid by one propagates to the other in real time (Supabase Realtime) — including
// the "you have been outbid" signal — without a reload.
//
// Uses auction a02 (seller = Waikato Trade Cars) so it doesn't collide with the
// happy-path spec (which uses the anchor a01). Bidders are two OTHER dealers.
const AUCTION_A02 = "/auction/a0000000-0000-0000-0000-000000000a02";

async function loginAs(context: BrowserContext, dealerName: RegExp): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
  return page;
}

async function placeBid(page: Page, dollars: string) {
  await page.getByLabel("Your max bid (NZD $)").fill(dollars);
  await page.getByRole("button", { name: "Place bid" }).click();
}

test("a bid by one dealer reaches another dealer's open auction in real time", async ({
  browser,
}) => {
  // Two isolated browser contexts = two real dealers with separate cookies.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  // Dealer A (Capital Auto Traders) and Dealer B (Southern Vehicle Exchange) —
  // neither is the seller of a02.
  const pageA = await loginAs(ctxA, /Capital Auto Traders/);
  const pageB = await loginAs(ctxB, /Southern Vehicle Exchange/);

  // Start watching for A's realtime websocket BEFORE navigating, so we can wait for
  // the subscription to be live before B bids — otherwise B's bid can land in the gap
  // before A is actually streaming changes, and A would never receive that event.
  const aRealtimeSocket = pageA.waitForEvent("websocket", {
    predicate: (ws) => ws.url().includes("/realtime/"),
    timeout: 15000,
  });
  await pageA.goto(AUCTION_A02);
  const socket = await aRealtimeSocket;
  // Opening the socket is not enough: wait for Supabase to confirm the postgres_changes
  // subscription is active ("Subscribed to PostgreSQL") — only then is A streaming DB changes.
  await socket.waitForEvent("framereceived", {
    predicate: (f) =>
      typeof f.payload === "string" && f.payload.includes("Subscribed to PostgreSQL"),
    timeout: 15000,
  });
  await pageB.goto(AUCTION_A02);

  // Dealer A takes the lead (first bid sits at the $8,500 floor — proxy keeps A's max hidden).
  await placeBid(pageA, "9000");
  await expect(pageA.getByText("Bid placed successfully.")).toBeVisible();

  // Dealer B outbids with a higher max. The engine resolves to min(A.max + increment, B.max)
  // = min(9000 + 250, 9500) = $9,250, with B as winner.
  await placeBid(pageB, "9500");
  await expect(pageB.getByText("Bid placed successfully.")).toBeVisible();

  // The money assertions: Dealer A is passively watching and must see, via realtime,
  // both the new current bid (the headline price) and the outbid alert — no reload.
  await expect(pageA.locator("p.text-4xl")).toHaveText("$9,250", { timeout: 8000 });
  await expect(pageA.getByText(/you have been outbid/i)).toBeVisible({ timeout: 8000 });

  await ctxA.close();
  await ctxB.close();
});
