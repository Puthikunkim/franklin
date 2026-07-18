import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333"; // fixture seller (never a bidder)

const created: string[] = [];
async function makeLive(): Promise<string> {
  const id = await createLiveAuction(D3); // Kia Sportage: starting 1,000,000 / reserve 1,200,000 / buy_now 1,500,000
  created.push(id);
  return id;
}
async function bid(auction: string, dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", {
    p_auction_id: auction, p_dealer_id: dealer, p_max_amount: max,
  });
  if (error) throw error;
}
async function notifs(recipient: string, type?: string) {
  let q = admin.from("notifications").select("type, auction_id").eq("recipient_dealer_id", recipient);
  if (type) q = q.eq("type", type);
  const { data } = await q;
  return data ?? [];
}

describe("notification generation in the writer RPCs", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("place_bid notifies the displaced leader when the lead changes", async () => {
    const id = await makeLive();
    await bid(id, D1, 1100000);          // D1 leads at the 1,000,000 starting price
    await bid(id, D2, 1300000);          // D2's max beats D1's proxy → D2 wins, D1 displaced
    const d1 = await notifs(D1, "outbid");
    expect(d1.length).toBe(1);
    expect(d1[0].auction_id).toBe(id);
    expect((await notifs(D2)).length).toBe(0); // the new leader is not notified
  });

  it("place_bid does NOT notify on a self-raise", async () => {
    const id = await makeLive();
    await bid(id, D1, 1100000);          // D1 leads
    await bid(id, D1, 1400000);          // D1 raises their own proxy
    expect((await notifs(D1, "outbid")).length).toBe(0);
  });

  it("place_bid does NOT create an outbid row when the leader's proxy holds", async () => {
    const id = await makeLive();
    await bid(id, D1, 1300000);          // D1 leads with a high proxy
    await bid(id, D2, 1250000);          // below D1's proxy → D1 holds the lead
    expect((await notifs(D1, "outbid")).length).toBe(0);
    expect((await notifs(D2, "outbid")).length).toBe(0);
  });

  it("close_auction notifies the winner (won) and the seller (sold) on a sold close", async () => {
    const id = await makeLive();
    await bid(id, D1, 1300000);          // D1 leads
    await bid(id, D2, 1250000);          // proxy holds → price rises to 1,275,000 (>= reserve), no outbid row
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const { data: status } = await admin.rpc("close_auction", { p_auction_id: id });
    expect(status).toBe("sold");
    expect((await notifs(D1, "won")).length).toBe(1);   // D1 is the winner
    expect((await notifs(D3, "sold")).length).toBe(1);  // D3 is the seller
  });

  it("close_auction creates no notifications on a passed (reserve-not-met) close", async () => {
    const id = await makeLive();
    await bid(id, D1, 1100000);          // single bid sits at 1,000,000 < reserve 1,200,000
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const { data: status } = await admin.rpc("close_auction", { p_auction_id: id });
    expect(status).toBe("passed");
    expect((await notifs(D1)).length).toBe(0);
    expect((await notifs(D3)).length).toBe(0);
  });

  it("buy_now_listing notifies the seller (sold) and the buyer gets no 'sold' row of their own", async () => {
    const id = await makeLive();
    const { data: result } = await admin.rpc("buy_now_listing", {
      p_auction_id: id, p_buyer_dealer_id: D1,
    });
    expect(result).toBe("bought");
    expect((await notifs(D3, "sold")).length).toBe(1); // seller
    expect((await notifs(D1, "sold")).length).toBe(0); // buyer: no 'sold' row (already redirected to /won)
    expect((await notifs(D1, "rate")).length).toBe(1); // buyer: prompted to rate the deal (Slice 12)
    expect((await notifs(D1)).length).toBe(1); // and NOTHING else — the rate prompt is the buyer's only notification
  });
});
