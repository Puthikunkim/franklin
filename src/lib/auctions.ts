import { serverClient } from "./supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getAuctionById(id: string) {
  const sb = await serverClient();
  const { data } = await sb.from("auctions")
    .select("*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)")
    .eq("id", id).maybeSingle();
  return data;
}

// Close every auction whose timer has run out (reuses close_auction per row via the
// close_expired_auctions() sweep). Called at the top of the home/dashboard renders so
// wins/sales/settlements/notifications materialize without a /won visit. Returns the count.
export async function closeExpiredAuctions(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.rpc("close_expired_auctions");
  // Surface a systematic sweep failure: a silent no-op here means expired auctions
  // never resolve (no settlement / won-sold notifications) — the exact bug this fixes.
  // The defensive end_time filter still keeps them off the grid regardless.
  if (error) console.error("close_expired_auctions failed:", error.message);
  return (data as number) ?? 0;
}
