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
