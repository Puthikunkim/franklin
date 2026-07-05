import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createDraftAuction, createLiveAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111"; // owner
const D2 = "22222222-2222-2222-2222-222222222222"; // another dealer

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
async function unpublish(auction: string, dealer: string) {
  const { data, error } = await admin.rpc("unpublish_listing", {
    p_auction_id: auction, p_dealer_id: dealer,
  });
  if (error) throw error;
  return data as string;
}

describe("unpublish_listing", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("reverts a live, un-bid, owned auction to a draft", async () => {
    const id = await makeLive(D1);
    expect(await unpublish(id, D1)).toBe("reverted");
    const { data: a } = await admin.from("auctions").select("status, start_time").eq("id", id).single();
    expect(a!.status).toBe("draft");
    expect(a!.start_time).toBeNull();
  });

  it("refuses a non-owner and leaves it live", async () => {
    const id = await makeLive(D1);
    expect(await unpublish(id, D2)).toBe("not_owner");
    const { data: a } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(a!.status).toBe("live");
  });

  it("refuses a non-live auction (a draft)", async () => {
    // Own-fixture draft, not the seeded one: dashboard tests' cleanupDrafts()
    // deletes the seeded draft, so relying on it is order-fragile.
    const draftId = await makeDraft(D1);
    expect(await unpublish(draftId, D1)).toBe("not_live");
  });

  it("refuses once bidding has started and leaves it live", async () => {
    const id = await makeLive(D1);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1000000 });
    expect(await unpublish(id, D1)).toBe("has_bids");
    const { data: a } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(a!.status).toBe("live");
  });

  it("leaves a valid draft that publish_listing can relist", async () => {
    const id = await makeLive(D1);
    await unpublish(id, D1);
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(r).toBe("live");
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const id = await makeLive(D1);
    const { error } = await anon.rpc("unpublish_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });
});
