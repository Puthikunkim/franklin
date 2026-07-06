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
  const { data } = await sb.rpc("close_expired_auctions");
  return (data as number) ?? 0;
}
