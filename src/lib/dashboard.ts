import type { SupabaseClient } from "@supabase/supabase-js";

const AUCTION_WITH_VEHICLE = "*, vehicle:vehicles(*)";

// Seller's auctions across every status (draft/live/ended/sold/passed), newest end first.
export async function getMyListings(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_VEHICLE)
    .eq("seller_dealer_id", dealerId)
    .order("end_time", { ascending: false });
  return data ?? [];
}

// Live auctions the dealer has placed a bid on (winning/outbid derived by the caller).
export async function getMyBiddingAuctions(sb: SupabaseClient, dealerId: string) {
  const { data: bidRows } = await sb
    .from("bids")
    .select("auction_id")
    .eq("bidder_dealer_id", dealerId);
  const ids = [...new Set((bidRows ?? []).map((b: { auction_id: string }) => b.auction_id))];
  if (ids.length === 0) return [];
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_VEHICLE)
    .in("id", ids)
    .eq("status", "live")
    // Exclude auctions whose timer has passed (still 'live' until close_auction runs)
    // so "Bidding on" means genuinely biddable — a won-but-unclosed auction belongs in
    // "My wins", not here.
    .gt("end_time", new Date().toISOString())
    .order("end_time", { ascending: true });
  return data ?? [];
}

// Auctions the dealer won: current winner, ended, and reserve met (a real sale to them).
// A withdrawn (cancelled) auction keeps its winner/bid/end_time, so it must be excluded here —
// otherwise it would resurface as a ghost "win" once its original end_time passes.
export async function getMyWins(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_VEHICLE)
    .eq("current_winner_dealer_id", dealerId)
    .neq("status", "cancelled")
    .lte("end_time", new Date().toISOString())
    .order("end_time", { ascending: false });
  return (data ?? []).filter(
    (a: { current_bid: number | null; reserve_price: number }) =>
      a.current_bid != null && a.current_bid >= a.reserve_price
  );
}

// Seller's completed auctions (sold or passed), with the settlement row when sold.
export async function getMySales(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("auctions")
    .select("*, vehicle:vehicles(*), settlement:settlements(*)")
    .eq("seller_dealer_id", dealerId)
    .in("status", ["sold", "passed"])
    .order("end_time", { ascending: false });
  return data ?? [];
}
