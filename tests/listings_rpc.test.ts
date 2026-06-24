import { describe, it, expect, beforeEach } from "vitest";
import { admin, cleanupDrafts } from "./helpers/db";

const SELLER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function draftArgs(overrides: Record<string, unknown> = {}) {
  return {
    p_dealer_id: SELLER,
    p_make: "Toyota", p_model: "Hilux", p_year: 2021, p_variant: "SR5",
    p_odometer_km: 40000, p_grade: "A", p_color: "White",
    p_mechanical_notes: "Tidy", p_appraisal_notes: "Clean",
    p_photo_urls: ["https://img.example/h1.jpg"],
    p_starting_price: 1000000, p_reserve_price: 1200000, p_buy_now_price: 1500000,
    p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
    ...overrides,
  };
}

describe("listing RPCs", () => {
  beforeEach(cleanupDrafts);

  it("creates a draft auction owned by the dealer, hidden from live", async () => {
    const { data: id, error } = await admin.rpc("create_draft_listing", draftArgs());
    expect(error).toBeNull();
    const { data: a } = await admin.from("auctions").select("*").eq("id", id).single();
    expect(a.status).toBe("draft");
    expect(a.seller_dealer_id).toBe(SELLER);
    expect(a.start_time).toBeNull();
    const { data: live } = await admin.from("auctions").select("id").eq("status", "live").eq("id", id);
    expect(live).toHaveLength(0);
  });

  it("rejects update from a non-owner", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs());
    const { data: r } = await admin.rpc("update_draft_listing", {
      p_auction_id: id, p_dealer_id: OTHER, p_make: "Toyota", p_model: "Hilux",
      p_year: 2021, p_variant: "SR5", p_odometer_km: 41000, p_grade: "A",
      p_color: "White", p_mechanical_notes: "x", p_appraisal_notes: "y",
      p_photo_urls: ["https://img.example/h1.jpg"], p_starting_price: 1000000,
      p_reserve_price: 1200000, p_buy_now_price: 1500000,
      p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    expect(r).toBe("not_owner");
  });

  it("publishes a valid draft to live with a start_time", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs());
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: SELLER });
    expect(r).toBe("live");
    const { data: a } = await admin.from("auctions").select("status, start_time").eq("id", id).single();
    expect(a.status).toBe("live");
    expect(a.start_time).not.toBeNull();
  });

  it("refuses to publish with an end_time in the past", async () => {
    const { data: id } = await admin.rpc("create_draft_listing",
      draftArgs({ p_end_time: new Date(Date.now() - 3600000).toISOString() }));
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: SELLER });
    expect(r).toBe("end_in_past");
  });

  it("refuses to publish with no photos", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs({ p_photo_urls: [] }));
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: SELLER });
    expect(r).toBe("no_photos");
  });

  it("refuses to publish someone else's draft", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs());
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: OTHER });
    expect(r).toBe("not_owner");
  });
});
