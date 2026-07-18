import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, createSoldAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111"; // buyer
const D2 = "22222222-2222-2222-2222-222222222222"; // uninvolved dealer
const D3 = "33333333-3333-3333-3333-333333333333"; // seller

const created: string[] = [];
async function makeSold(seller = D3, buyer = D1): Promise<string> {
  const id = await createSoldAuction(seller, buyer);
  created.push(id);
  return id;
}
async function submit(auction: string, rater: string, score: number, comment: string | null = null) {
  const { data, error } = await admin.rpc("submit_rating", {
    p_auction_id: auction, p_rater_dealer_id: rater, p_score: score, p_comment: comment,
  });
  if (error) throw error;
  return data as string;
}

describe("submit_rating", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("records a buyer's rating of the seller with direction 'seller'", async () => {
    const id = await makeSold();
    expect(await submit(id, D1, 5, "  Exactly as graded  ")).toBe("ok");
    const { data: rows } = await admin.from("ratings").select("*").eq("auction_id", id);
    expect(rows).toHaveLength(1);
    expect(rows![0].ratee_dealer_id).toBe(D3);
    expect(rows![0].direction).toBe("seller");
    expect(rows![0].score).toBe(5);
    expect(rows![0].comment).toBe("Exactly as graded"); // trimmed
  });

  it("records a seller's rating of the buyer with direction 'buyer'", async () => {
    const id = await makeSold();
    expect(await submit(id, D3, 4)).toBe("ok");
    const { data: rows } = await admin.from("ratings").select("*").eq("auction_id", id);
    expect(rows![0].ratee_dealer_id).toBe(D1);
    expect(rows![0].direction).toBe("buyer");
    expect(rows![0].comment).toBeNull(); // empty/omitted comment stored as null
  });

  it("rejects a rating on an auction that is not sold", async () => {
    const live = await createLiveAuction(D3);
    created.push(live);
    expect(await submit(live, D1, 5)).toBe("not_sold");
  });

  it("rejects a rater who is neither buyer nor seller", async () => {
    const id = await makeSold();
    expect(await submit(id, D2, 5)).toBe("not_party");
  });

  it("rejects a second rating from the same party", async () => {
    const id = await makeSold();
    await submit(id, D1, 5);
    expect(await submit(id, D1, 3)).toBe("already_rated");
  });

  it("rejects a rating after the 14-day window has closed", async () => {
    const id = await makeSold();
    await admin.rpc("test_set_settlement_age", { p_auction_id: id, p_seconds: 15 * 86400 });
    expect(await submit(id, D1, 5)).toBe("window_closed");
  });

  it("rejects an out-of-range score", async () => {
    const id = await makeSold();
    expect(await submit(id, D1, 6)).toBe("bad_score");
  });

  it("forbids the anon (browser) role from calling the writer", async () => {
    const id = await makeSold();
    const { error } = await anon.rpc("submit_rating", {
      p_auction_id: id, p_rater_dealer_id: D1, p_score: 5, p_comment: null,
    });
    expect(error).not.toBeNull();
  });
});

describe("rate-your-deal notifications", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("close_auction notifies both parties to rate", async () => {
    const id = await makeSold(); // seller D3, buyer D1, closed inside the helper
    const { data: n } = await admin.from("notifications").select("*").eq("auction_id", id).eq("type", "rate");
    const recips = (n ?? []).map((r) => r.recipient_dealer_id).sort();
    expect(recips).toEqual([D1, D3].sort());
  });

  it("buy_now_listing notifies both parties to rate", async () => {
    const CRV = "a0000000-0000-0000-0000-000000000a03"; // seed buy-now auction, seller D3
    const { error } = await admin.rpc("buy_now_listing", { p_auction_id: CRV, p_buyer_dealer_id: D1 });
    if (error) throw error;
    const { data: n } = await admin.from("notifications").select("*").eq("auction_id", CRV).eq("type", "rate");
    const recips = (n ?? []).map((r) => r.recipient_dealer_id).sort();
    expect(recips).toEqual([D1, D3].sort());
  });
});

const D4 = "44444444-4444-4444-4444-444444444444"; // never rated

describe("blind-reveal visibility", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  async function repOf(dealer: string) {
    const { data } = await admin.rpc("get_dealers_reputation", { p_dealer_ids: [dealer] });
    return (data as any[])[0];
  }
  async function stateFor(auction: string, viewer: string) {
    const { data } = await admin.rpc("get_rating_state", { p_auction_id: auction, p_viewer_dealer_id: viewer });
    return (data as any[])[0];
  }

  it("hides a lone rating from the counterparty and from the aggregate until reveal", async () => {
    const id = await makeSold();
    await submit(id, D1, 5); // buyer rates seller D3; only one rating so far
    const sellerRep = await repOf(D3);
    expect(sellerRep.seller_count).toBe(0);        // not visible yet
    const stateForSeller = await stateFor(id, D3);
    expect(stateForSeller.counterpart_submitted).toBe(true);
    expect(stateForSeller.revealed).toBe(false);
    expect(stateForSeller.counterpart_score).toBeNull(); // blind
  });

  it("reveals both ratings once both parties have submitted", async () => {
    const id = await makeSold();
    await submit(id, D1, 5);
    await submit(id, D3, 4);
    const sellerRep = await repOf(D3);
    const buyerRep = await repOf(D1);
    expect(sellerRep.seller_count).toBe(1);
    expect(Number(sellerRep.seller_avg)).toBe(5);
    expect(buyerRep.buyer_count).toBe(1);
    expect(Number(buyerRep.buyer_avg)).toBe(4);
    const state = await stateFor(id, D1);
    expect(state.revealed).toBe(true);
    expect(state.counterpart_score).toBe(4);
  });

  it("reveals a lone rating once the 14-day window elapses", async () => {
    const id = await makeSold();
    await submit(id, D1, 3);
    await admin.rpc("test_set_settlement_age", { p_auction_id: id, p_seconds: 15 * 86400 });
    const sellerRep = await repOf(D3);
    expect(sellerRep.seller_count).toBe(1);
    expect(Number(sellerRep.seller_avg)).toBe(3);
  });

  it("returns a zero-filled row for a dealer with no visible ratings", async () => {
    const rep = await repOf(D4);
    expect(rep.dealer_id).toBe(D4);
    expect(rep.seller_count).toBe(0);
    expect(rep.seller_avg).toBeNull();
  });

  it("marks a non-party viewer ineligible", async () => {
    const id = await makeSold();
    const state = await stateFor(id, D4);
    expect(state.eligible).toBe(false);
  });
});
