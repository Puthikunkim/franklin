import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { getDealer, getDealerLiveListings, getDealerSales } from "@/lib/dealers";

const D1 = "11111111-1111-1111-1111-111111111111"; // Auckland Motor Wholesale
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333";
const A01 = "a0000000-0000-0000-0000-000000000a01"; // Corolla, seller D1, live
const A06 = "a0000000-0000-0000-0000-000000000a06"; // Hilux, seller D1, live
const DRAFT_D1 = "a0000000-0000-0000-0000-0000000000d1"; // Navara, seller D1, DRAFT

const created: string[] = [];

describe("dealer profile reads", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("getDealer returns the row for a known id and null for an unknown id", async () => {
    const d = await getDealer(admin, D1);
    expect(d).not.toBeNull();
    expect(d!.business_name).toBe("Auckland Motor Wholesale");
    expect(d!.is_verified).toBe(true);
    expect(await getDealer(admin, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getDealerLiveListings returns only the dealer's live, future auctions (not drafts, not other dealers)", async () => {
    const rows = await getDealerLiveListings(admin, D1);
    const ids = rows.map((a) => a.id);
    expect(ids).toContain(A01);
    expect(ids).toContain(A06);
    expect(ids).not.toContain(DRAFT_D1); // draft excluded
    expect(rows.every((a) => a.seller_dealer_id === D1 && a.status === "live")).toBe(true);
    expect(rows[0].vehicle).toBeTruthy(); // vehicle embedded for AuctionCard
  });

  it("getDealerSales returns only the dealer's sold auctions with their settlement", async () => {
    // Build a completed sale for D1: create → push above reserve → expire → close.
    const id = await createLiveAuction(D1); created.push(id);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1300000 }); // D2 leads
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D3, p_max_amount: 1250000 }); // proxy holds → price 1,275,000
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const { data: closed } = await admin.rpc("close_auction", { p_auction_id: id });
    expect(closed).toBe("sold");

    const sales = await getDealerSales(admin, D1);
    const sale = sales.find((s) => s.id === id);
    expect(sale).toBeTruthy();
    const settlement = Array.isArray(sale.settlement) ? sale.settlement[0] : sale.settlement;
    expect(settlement.sale_price).toBe(1275000);
    expect(sales.every((s) => s.status === "sold")).toBe(true);
    expect(sales.map((s) => s.id)).not.toContain(A01); // a live auction is not a sale
  });
});
