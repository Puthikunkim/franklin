import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb } from "./helpers/db";
import { getMyWins, getMySales } from "../src/lib/dashboard";

const D1 = "11111111-1111-1111-1111-111111111111"; // buyer (Auckland)
const D2 = "22222222-2222-2222-2222-222222222222"; // a rival bidder
const D3 = "33333333-3333-3333-3333-333333333333"; // SELLER of the CR-V
const CRV = "a0000000-0000-0000-0000-000000000a03"; // Honda CR-V, seller D3, buy_now 1100000, no bids after reset
const CRV_BUY_NOW = 1100000;

async function buyNow(auction: string, buyer: string) {
  const { data, error } = await admin.rpc("buy_now_listing", {
    p_auction_id: auction, p_buyer_dealer_id: buyer,
  });
  if (error) throw error;
  return data as string;
}

describe("buy_now_listing", () => {
  beforeEach(resetDb);

  // The "no buy_now_price" test nulls a03.buy_now_price via a raw update; restore it
  // here so that mutation can't leak into later tests/files sharing this local DB.
  afterEach(async () => {
    await admin.from("auctions").update({ buy_now_price: CRV_BUY_NOW }).eq("id", CRV);
  });

  it("sells a live, un-bid auction to a non-seller buyer and settles it", async () => {
    expect(await buyNow(CRV, D1)).toBe("bought");
    const { data: a } = await admin.from("auctions").select("*").eq("id", CRV).single();
    expect(a!.status).toBe("sold");
    expect(a!.current_winner_dealer_id).toBe(D1);
    expect(a!.current_bid).toBe(CRV_BUY_NOW);
    expect(new Date(a!.end_time).getTime()).toBeLessThanOrEqual(Date.now() + 2000);
    const { data: s } = await admin.from("settlements").select("*").eq("auction_id", CRV).single();
    expect(s!.sale_price).toBe(CRV_BUY_NOW);
    expect(s!.seller_fee).toBe(20000);
    expect(s!.buyer_fee).toBe(2000);
  });

  it("refuses once bidding has started", async () => {
    await admin.rpc("place_bid", { p_auction_id: CRV, p_dealer_id: D2, p_max_amount: 750000 });
    expect(await buyNow(CRV, D1)).toBe("has_bids");
    const { data: a } = await admin.from("auctions").select("status").eq("id", CRV).single();
    expect(a!.status).toBe("live");
  });

  it("refuses to let the seller buy their own listing", async () => {
    expect(await buyNow(CRV, D3)).toBe("is_seller");
  });

  it("refuses an auction with no buy_now_price", async () => {
    await admin.from("auctions").update({ buy_now_price: null }).eq("id", CRV);
    expect(await buyNow(CRV, D1)).toBe("no_buy_now");
  });

  it("is idempotent — a second buy returns the sold status (not 'bought') and never double-settles", async () => {
    expect(await buyNow(CRV, D1)).toBe("bought");
    expect(await buyNow(CRV, D2)).toBe("sold"); // already-sold status, NOT a fresh purchase
    const { data: s } = await admin.from("settlements").select("id").eq("auction_id", CRV);
    expect(s).toHaveLength(1);
    const { data: a } = await admin.from("auctions").select("current_winner_dealer_id").eq("id", CRV).single();
    expect(a!.current_winner_dealer_id).toBe(D1); // D2 did not steal it
  });

  it("makes the sale show in the buyer's wins and the seller's sales", async () => {
    await buyNow(CRV, D1);
    expect((await getMyWins(admin, D1)).some((r: { id: string }) => r.id === CRV)).toBe(true);
    expect((await getMySales(admin, D3)).some((r: { id: string }) => r.id === CRV)).toBe(true);
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const { error } = await anon.rpc("buy_now_listing", { p_auction_id: CRV, p_buyer_dealer_id: D1 });
    expect(error).not.toBeNull();
  });
});
