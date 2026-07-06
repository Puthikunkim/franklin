import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, createDraftAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111"; // seller / owner
const D2 = "22222222-2222-2222-2222-222222222222"; // bidder
const D3 = "33333333-3333-3333-3333-333333333333"; // bidder

const created: string[] = [];
async function makeLive(dealer = D1): Promise<string> {
  const id = await createLiveAuction(dealer);
  created.push(id);
  return id;
}
async function makeDraft(dealer = D1): Promise<string> {
  const id = await createDraftAuction(dealer);
  created.push(id);
  return id;
}
async function bid(auction: string, dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", { p_auction_id: auction, p_dealer_id: dealer, p_max_amount: max });
  if (error) throw error;
}
async function withdraw(auction: string, dealer: string): Promise<string> {
  const { data, error } = await admin.rpc("withdraw_listing", { p_auction_id: auction, p_dealer_id: dealer });
  if (error) throw error;
  return data as string;
}
async function withdrawnNotifs(recipient: string) {
  const { data } = await admin.from("notifications").select("id")
    .eq("recipient_dealer_id", recipient).eq("type", "withdrawn");
  return data ?? [];
}
async function statusOf(id: string): Promise<string> {
  const { data } = await admin.from("auctions").select("status").eq("id", id).single();
  return data!.status as string;
}

describe("withdraw_listing", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("cancels a live bid-on auction and notifies each distinct bidder once", async () => {
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);   // D2 leads at the 1,000,000 starting price
    await bid(id, D3, 1300000);   // D3 outbids D2 (D2 also gets an 'outbid' notif — a different type)
    await bid(id, D2, 1150000);   // D2 bids again (below D3's proxy) — D2 has now bid twice
    expect(await withdraw(id, D1)).toBe("withdrawn");
    expect(await statusOf(id)).toBe("cancelled");
    expect((await withdrawnNotifs(D2)).length).toBe(1); // distinct: one, not two
    expect((await withdrawnNotifs(D3)).length).toBe(1);
  });

  it("refuses a non-owner and leaves it live", async () => {
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);
    expect(await withdraw(id, D2)).toBe("not_owner");
    expect(await statusOf(id)).toBe("live");
  });

  it("refuses a non-live auction (a draft)", async () => {
    const id = await makeDraft(D1);
    expect(await withdraw(id, D1)).toBe("not_live");
  });

  it("refuses a live auction with no bids", async () => {
    const id = await makeLive(D1);
    expect(await withdraw(id, D1)).toBe("no_bids");
    expect(await statusOf(id)).toBe("live");
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);
    const { error } = await anon.rpc("withdraw_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });

  it("removes a cancelled auction from search and from the bidder's 'Bidding on'", async () => {
    const { getMyBiddingAuctions } = await import("../src/lib/dashboard");
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);
    await withdraw(id, D1);
    const { data: search } = await admin.rpc("search_live_auctions", {
      p_q: null, p_grades: null, p_min_price: null, p_max_price: null, p_region: null, p_sort: null,
    });
    expect((search as { id: string }[]).map((r) => r.id)).not.toContain(id);
    const bidding = await getMyBiddingAuctions(admin, D2);
    expect(bidding.map((a: { id: string }) => a.id)).not.toContain(id);
  });
});
