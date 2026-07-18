import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createSoldAuction, deleteAuctions } from "./helpers/db";
import { getDealersReputation, getDealerReviews, getRatingState } from "@/lib/ratings";

const D1 = "11111111-1111-1111-1111-111111111111";
const D3 = "33333333-3333-3333-3333-333333333333";

const created: string[] = [];

describe("ratings library (readers)", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("getDealersReputation returns a row per requested dealer", async () => {
    const id = await createSoldAuction(D3, D1); created.push(id);
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D1, p_score: 5, p_comment: "Tidy" });
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D3, p_score: 4, p_comment: null });
    const reps = await getDealersReputation(admin, [D3, D1]);
    const seller = reps.find((r) => r.dealer_id === D3)!;
    expect(seller.seller_count).toBe(1);
    expect(Number(seller.seller_avg)).toBe(5);
  });

  it("getDealerReviews returns visible comments for the ratee", async () => {
    const id = await createSoldAuction(D3, D1); created.push(id);
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D1, p_score: 5, p_comment: "Tidy" });
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D3, p_score: 4, p_comment: null });
    const reviews = await getDealerReviews(admin, D3);
    expect(reviews[0].direction).toBe("seller");
    expect(reviews[0].comment).toBe("Tidy");
  });

  it("getRatingState reports eligibility for a party", async () => {
    const id = await createSoldAuction(D3, D1); created.push(id);
    const state = await getRatingState(admin, id, D1);
    expect(state?.eligible).toBe(true);
    expect(state?.already_rated).toBe(false);
  });
});
