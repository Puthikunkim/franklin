import { serverClient } from "./supabase/server";

export async function getAuctionById(id: string) {
  const sb = await serverClient();
  const { data } = await sb.from("auctions")
    .select("*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)")
    .eq("id", id).maybeSingle();
  return data;
}
