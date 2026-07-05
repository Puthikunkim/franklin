import { serviceClient } from "@/lib/supabase/service";

// Server-only: writes via the service-role client. NEVER import into a "use client" module.
export async function buyNow(
  dealerId: string,
  auctionId: string
): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("buy_now_listing", {
    p_auction_id: auctionId,
    p_buyer_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  // 'bought' means THIS call completed the purchase. Any other token (including the
  // 'sold' STATUS of an already-sold auction) is a failure for this buyer.
  return data === "bought" ? { ok: true } : { ok: false, reason: data as string };
}
