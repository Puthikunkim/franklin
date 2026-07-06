import type { SupabaseClient } from "@supabase/supabase-js";
import type { Dealer } from "@/types/db";

const AUCTION_WITH_JOINS =
  "*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)";

// The dealer row for a profile, or null if the id is unknown (page → notFound()).
export async function getDealer(sb: SupabaseClient, id: string): Promise<Dealer | null> {
  const { data } = await sb.from("dealers").select("*").eq("id", id).maybeSingle();
  return (data as Dealer) ?? null;
}

// A dealer's currently-live listings (status='live', not yet ended), ending soonest first.
// The seller join lets the profile page reuse AuctionCard.
export async function getDealerLiveListings(sb: SupabaseClient, id: string): Promise<any[]> {
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_JOINS)
    .eq("seller_dealer_id", id)
    .eq("status", "live")
    .gt("end_time", new Date().toISOString())
    .order("end_time", { ascending: true });
  return data ?? [];
}

// A dealer's completed sales (status='sold') with the settlement, most recent first.
export async function getDealerSales(sb: SupabaseClient, id: string): Promise<any[]> {
  const { data } = await sb
    .from("auctions")
    .select("*, vehicle:vehicles(*), settlement:settlements(*)")
    .eq("seller_dealer_id", id)
    .eq("status", "sold")
    .order("end_time", { ascending: false });
  return data ?? [];
}
