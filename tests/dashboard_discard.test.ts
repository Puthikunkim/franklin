import { describe, it, expect, beforeEach } from "vitest";
import { admin, anon, cleanupDrafts } from "./helpers/db";
import { discardDraft } from "../src/lib/listings/service";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const ANCHOR = "a0000000-0000-0000-0000-000000000a01"; // a live auction, not a draft

async function makeDraft(dealer = D1): Promise<string> {
  const { data } = await admin.rpc("create_draft_listing", {
    p_dealer_id: dealer, p_make: "Ford", p_model: "Ranger", p_year: 2020, p_variant: "XLT",
    p_odometer_km: 60000, p_grade: "B", p_color: "Blue", p_mechanical_notes: "", p_appraisal_notes: "",
    p_photo_urls: ["https://img/1.jpg"], p_starting_price: 1000000, p_reserve_price: 1200000,
    p_buy_now_price: null, p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  return data as string;
}

describe("discard_draft_listing", () => {
  beforeEach(cleanupDrafts);

  it("discards an owned draft and deletes its vehicle", async () => {
    const id = await makeDraft(D1);
    const { data: a } = await admin.from("auctions").select("vehicle_id").eq("id", id).single();
    const r = await discardDraft(D1, id);
    expect(r).toEqual({ ok: true });
    const { data: gone } = await admin.from("auctions").select("id").eq("id", id);
    expect(gone).toHaveLength(0);
    const { data: veh } = await admin.from("vehicles").select("id").eq("id", a!.vehicle_id);
    expect(veh).toHaveLength(0);
  });

  it("refuses to discard someone else's draft", async () => {
    const id = await makeDraft(D1);
    expect(await discardDraft(D2, id)).toEqual({ ok: false, reason: "not_owner" });
  });

  it("refuses to discard a non-draft auction", async () => {
    expect(await discardDraft(D1, ANCHOR)).toEqual({ ok: false, reason: "not_draft" });
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const id = await makeDraft(D1);
    const { error } = await anon.rpc("discard_draft_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });
});
