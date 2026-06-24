import { serverClient } from "./supabase/server";

export async function getLiveAuctions() {
  const sb = await serverClient();
  const { data } = await sb.from("auctions")
    .select("*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)")
    .eq("status", "live").order("end_time", { ascending: true });
  return data ?? [];
}
