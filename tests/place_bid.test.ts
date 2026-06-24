import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb } from "./helpers/db";

// Real anchor auction from seed.sql
const AUCTION = "a0000000-0000-0000-0000-000000000a01";
// Seeded dealer IDs
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

async function bid(auction: string, dealer: string, max: number) {
  const { data, error } = await admin.rpc("place_bid", {
    p_auction_id: auction,
    p_dealer_id: dealer,
    p_max_amount: max,
  });
  if (error) throw error;
  // place_bid returns TABLE(...) so supabase-js wraps it as an array
  return data[0];
}

describe("place_bid", () => {
  beforeEach(resetDb);

  it("accepts a first bid at the starting price", async () => {
    const r = await bid(AUCTION, A, 650000);
    expect(r.status).toBe("accepted");
    expect(r.current_bid).toBe(600000); // starting_price
    expect(r.current_winner_dealer_id).toBe(A);
  });

  it("rejects a bid below current + increment", async () => {
    await bid(AUCTION, A, 650000);
    const r = await bid(AUCTION, B, 610000); // < 600000 + 25000
    expect(r.status).toBe("rejected");
    expect(r.reason).toBe("below_minimum");
  });

  it("resolves two proxies so higher max wins at loser_max + increment", async () => {
    await bid(AUCTION, A, 650000);
    const r = await bid(AUCTION, B, 900000);
    expect(r.status).toBe("accepted");
    expect(r.current_winner_dealer_id).toBe(B);
    expect(r.current_bid).toBe(675000); // 650000 + 25000
  });

  it("extends end_time when bid lands inside the anti-snipe window", async () => {
    // Place normal first bid (auction is ~2h out — no anti-snipe extension)
    await bid(AUCTION, A, 650000);
    // Now shrink the window so the NEXT bid lands inside it
    await admin.rpc("test_set_end_in_seconds", {
      p_auction_id: AUCTION,
      p_seconds: 10,
    });
    // Read the current end_time BEFORE the challenger bid
    const { data: auctionRow } = await admin
      .from("auctions")
      .select("end_time")
      .eq("id", AUCTION)
      .single();
    const before = auctionRow!.end_time;
    // Challenger bid — should trigger anti-snipe extension
    const r = await bid(AUCTION, B, 900000);
    const after = r.end_time;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("rejects bids on an ended auction", async () => {
    await admin.rpc("test_set_end_in_seconds", {
      p_auction_id: AUCTION,
      p_seconds: -5,
    });
    const r = await bid(AUCTION, A, 650000);
    expect(r.status).toBe("rejected");
    expect(r.reason).toBe("auction_ended");
  });
});
