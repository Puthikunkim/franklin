import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { unpublishListing } from "../src/lib/listings/service";

const D1 = "11111111-1111-1111-1111-111111111111"; // owner
const D2 = "22222222-2222-2222-2222-222222222222"; // another dealer

const created: string[] = [];
async function makeLive(dealer = D1): Promise<string> {
  const id = await createLiveAuction(dealer);
  created.push(id);
  return id;
}

describe("unpublishListing service", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("reverts a live auction and returns ok", async () => {
    const id = await makeLive(D1);
    expect(await unpublishListing(D1, id)).toEqual({ ok: true });
    const { data: a } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(a!.status).toBe("draft");
  });

  it("returns the reason when a non-owner tries", async () => {
    const id = await makeLive(D1);
    expect(await unpublishListing(D2, id)).toEqual({ ok: false, reason: "not_owner" });
  });
});
