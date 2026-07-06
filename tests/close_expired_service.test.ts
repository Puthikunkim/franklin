import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { closeExpiredAuctions } from "@/lib/auctions";

const D3 = "33333333-3333-3333-3333-333333333333";
const created: string[] = [];

describe("closeExpiredAuctions service", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("closes expired auctions and returns the count", async () => {
    const id = await createLiveAuction(D3); created.push(id);
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const n = await closeExpiredAuctions(admin);
    expect(n).toBe(1);
    const { data } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(data!.status).toBe("passed"); // no bids → passed
  });
});
