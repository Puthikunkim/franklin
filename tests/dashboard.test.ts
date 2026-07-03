import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb, cleanupDrafts } from "./helpers/db";
import { getMyListings, getMyBiddingAuctions, getMyWins, getMySales } from "../src/lib/dashboard";

const ANCHOR = "a0000000-0000-0000-0000-000000000a01"; // live, seller = dealer 1, start 600000, reserve 750000
const D1 = "11111111-1111-1111-1111-111111111111"; // anchor seller
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333";

async function bid(dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", { p_auction_id: ANCHOR, p_dealer_id: dealer, p_max_amount: max });
  if (error) throw error;
}

describe("dashboard queries", () => {
  beforeEach(async () => { await resetDb(); await cleanupDrafts(); });

  it("getMyListings returns the seller's auctions including drafts", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", {
      p_dealer_id: D2, p_make: "Kia", p_model: "Sportage", p_year: 2021, p_variant: "GT",
      p_odometer_km: 30000, p_grade: "A", p_color: "Red", p_mechanical_notes: "", p_appraisal_notes: "",
      p_photo_urls: ["https://img/1.jpg"], p_starting_price: 1000000, p_reserve_price: 1200000,
      p_buy_now_price: null, p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    const rows = await getMyListings(admin, D2);
    expect(rows.some((r: any) => r.id === id && r.status === "draft")).toBe(true);
    // dealer-scoped: D2's listings do not include the anchor (owned by D1)
    expect(rows.some((r: any) => r.id === ANCHOR)).toBe(false);
  });

  it("getMyBiddingAuctions returns live auctions the dealer has bid on", async () => {
    await bid(D2, 650000);
    const rows = await getMyBiddingAuctions(admin, D2);
    expect(rows.some((r: any) => r.id === ANCHOR)).toBe(true);
    expect(rows[0].current_winner_dealer_id).toBe(D2); // D2 is winning
    // a dealer who never bid sees nothing here
    expect(await getMyBiddingAuctions(admin, D3)).toHaveLength(0);
  });

  it("getMyWins returns ended auctions the dealer won with reserve met", async () => {
    await bid(D2, 800000);
    await bid(D3, 780000); // competition pushes price to 800000 (>= reserve 750000), D2 still winner
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: ANCHOR, p_seconds: -10 });
    const wins = await getMyWins(admin, D2);
    expect(wins.some((r: any) => r.id === ANCHOR)).toBe(true);
    // D3 lost — not a win
    expect(await getMyWins(admin, D3)).toHaveLength(0);
  });

  it("getMySales returns the seller's sold auctions with settlement", async () => {
    await bid(D2, 800000);
    await bid(D3, 780000);
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: ANCHOR, p_seconds: -10 });
    await admin.rpc("close_auction", { p_auction_id: ANCHOR }); // -> sold, settlement inserted
    const sales = await getMySales(admin, D1);
    const row = sales.find((r: any) => r.id === ANCHOR);
    expect(row).toBeDefined();
    const s = Array.isArray(row.settlement) ? row.settlement[0] : row.settlement;
    expect(s.sale_price).toBe(800000);
  });
});
