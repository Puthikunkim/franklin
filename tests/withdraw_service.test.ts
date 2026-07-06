import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { withdrawListing } from "@/lib/listings/service";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const created: string[] = [];

describe("withdrawListing service", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("withdraws a live bid-on auction owned by the dealer", async () => {
    const id = await createLiveAuction(D1); created.push(id);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1100000 });
    expect(await withdrawListing(D1, id)).toEqual({ ok: true });
    const { data } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(data!.status).toBe("cancelled");
  });

  it("returns the reason for a non-owner", async () => {
    const id = await createLiveAuction(D1); created.push(id);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1100000 });
    expect(await withdrawListing(D2, id)).toEqual({ ok: false, reason: "not_owner" });
  });
});
