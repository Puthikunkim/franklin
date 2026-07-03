import { serviceClient } from "@/lib/supabase/service";

// Server-only: writes via the service-role client. NEVER import into a "use client" module.
export async function setWatch(
  dealerId: string,
  auctionId: string,
  watched: boolean
): Promise<{ ok: boolean; watched?: boolean }> {
  const { data, error } = await serviceClient().rpc("set_watch", {
    p_dealer_id: dealerId,
    p_auction_id: auctionId,
    p_watched: watched,
  });
  if (error) return { ok: false };
  return { ok: true, watched: data as boolean };
}
