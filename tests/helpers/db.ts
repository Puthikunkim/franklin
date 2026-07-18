import { createClient } from "@supabase/supabase-js";

// Local supabase defaults from `supabase start` output:
export const admin = createClient(
  process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
);

// Browser-equivalent read-only client (anon key). Used to prove writer RPCs are not callable.
export const anon = createClient(
  process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
  process.env.SUPABASE_ANON_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
);

export async function resetDb() {
  // Truncate bids/settlements and reset auction cached state between tests.
  const { error } = await admin.rpc("test_reset"); // defined in migration
  if (error) throw error;
}

// Remove draft auctions (and their now-orphaned vehicles) created by listing tests.
export async function cleanupDrafts() {
  const { data: drafts } = await admin.from("auctions").select("id, vehicle_id").eq("status", "draft");
  const ids = (drafts ?? []).map((d) => d.id);
  const vids = (drafts ?? []).map((d) => d.vehicle_id);
  if (ids.length) await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
}

// Create a DRAFT auction (vehicle + draft) owned by `dealer` and return its id.
// The caller is responsible for cleanup via deleteAuctions([...]).
export async function createDraftAuction(dealer: string): Promise<string> {
  const { data: id } = await admin.rpc("create_draft_listing", {
    p_dealer_id: dealer, p_make: "Kia", p_model: "Sportage", p_year: 2021, p_variant: "GT",
    p_odometer_km: 30000, p_grade: "A", p_color: "Red", p_mechanical_notes: "", p_appraisal_notes: "",
    p_photo_urls: ["https://img/1.jpg"], p_starting_price: 1000000, p_reserve_price: 1200000,
    p_buy_now_price: 1500000, p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  return id as string;
}

// Create a published (live), un-bid auction owned by `dealer` and return its id.
// The caller is responsible for cleanup via deleteAuctions([...]).
export async function createLiveAuction(dealer: string): Promise<string> {
  const id = await createDraftAuction(dealer);
  await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: dealer });
  return id;
}

// Delete test-created auctions and everything that FK-references them — bids,
// settlements, and notifications first, then the auctions, then their vehicles
// (none of these FKs cascade) — so reverted-to-draft, leftover-live, or settled
// fixtures never leak into later shared-DB tests.
export async function deleteAuctions(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { data: rows } = await admin.from("auctions").select("vehicle_id").in("id", ids);
  const vids = (rows ?? []).map((r: { vehicle_id: string }) => r.vehicle_id);
  await admin.from("ratings").delete().in("auction_id", ids);
  await admin.from("bids").delete().in("auction_id", ids);
  await admin.from("settlements").delete().in("auction_id", ids);
  await admin.from("notifications").delete().in("auction_id", ids);
  await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
}

// Create a live auction owned by `seller`, push it above reserve with `buyer` as the
// winning proxy bidder, expire it and close it to 'sold'. Returns the (now sold) auction
// id. Caller cleans up via deleteAuctions([...]). createLiveAuction uses starting_price =
// 1_000_000c and reserve = 1_200_000c. A single bid always wins at the starting price
// (proxy bidding — see place_bid's "no bids yet: open at starting price" branch), which
// sits below reserve, so one bid alone never reaches 'sold' (see close_expired.test.ts's
// "D1 leads at the 1,000,000 starting price" and dealers.test.ts's two-bid fixture). A
// second, lower underbid from `seller` (a price-pushing rival here, not a real
// counterparty) forces buyer's proxy to rise to 1,275,000 while buyer stays the winner.
export async function createSoldAuction(seller: string, buyer: string): Promise<string> {
  const id = await createLiveAuction(seller);
  await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: buyer, p_max_amount: 1300000 }); // buyer leads at 1,000,000
  await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: seller, p_max_amount: 1250000 }); // buyer's proxy holds → price 1,275,000 (>= reserve)
  await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
  await admin.rpc("close_auction", { p_auction_id: id });
  return id;
}
