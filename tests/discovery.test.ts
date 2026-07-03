import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb } from "./helpers/db";
import {
  parseFilters, searchLiveAuctions, getWatchedAuctionIds, getMyWatching,
} from "../src/lib/discovery";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const A01 = "a0000000-0000-0000-0000-000000000a01"; // Corolla, D1
const A02 = "a0000000-0000-0000-0000-000000000a02"; // CX-5, D2

async function clearWatches() {
  await admin.from("watchlist").delete().not("dealer_id", "is", null);
}

describe("parseFilters", () => {
  it("keeps valid params and converts dollar prices to cents", () => {
    const f = parseFilters({ q: "corolla", grade: "A,B", min: "10000", max: "13000",
      region: "Auckland", sort: "price_asc" });
    expect(f).toEqual({ q: "corolla", grades: ["A", "B"], minPrice: 1000000,
      maxPrice: 1300000, region: "Auckland", sort: "price_asc" });
  });

  it("drops garbage (bad grades, non-numeric prices, unknown sort/region, blanks)", () => {
    const f = parseFilters({ q: "  ", grade: "Z,,A", min: "abc", max: "-5",
      region: "Narnia", sort: "chaos" });
    expect(f).toEqual({ q: undefined, grades: ["A"], minPrice: undefined,
      maxPrice: undefined, region: undefined, sort: undefined });
  });

  it("handles array-valued params by taking the first", () => {
    expect(parseFilters({ q: ["hi", "there"] }).q).toBe("hi");
  });
});

describe("discovery reads", () => {
  beforeEach(async () => { await resetDb(); await clearWatches(); });

  it("searchLiveAuctions returns joined rows in the RPC's sort order", async () => {
    const rows = await searchLiveAuctions(admin, { sort: "price_asc" });
    // joins present
    expect(rows[0].vehicle).toBeTruthy();
    expect(rows[0].seller).toBeTruthy();
    // order preserved (ascending current price)
    const prices = rows.map((r: any) => r.current_bid ?? r.starting_price);
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
  });

  it("searchLiveAuctions applies filters", async () => {
    const rows = await searchLiveAuctions(admin, { q: "corolla" });
    expect(rows.map((r: any) => r.id)).toEqual([A01]);
  });

  it("getWatchedAuctionIds is dealer-scoped", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: A02, p_watched: true });
    expect(await getWatchedAuctionIds(admin, D1)).toEqual([A02]);
    expect(await getWatchedAuctionIds(admin, D2)).toEqual([]);
  });

  it("getMyWatching returns the dealer's watched auctions with vehicle", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: A02, p_watched: true });
    const rows = await getMyWatching(admin, D1);
    expect(rows.map((r: any) => r.id)).toEqual([A02]);
    expect(rows[0].vehicle.make).toBe("Mazda");
    expect(await getMyWatching(admin, D2)).toEqual([]);
  });
});
