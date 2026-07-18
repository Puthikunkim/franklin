import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import type { DealerReputation, DealerReview, RatingState } from "@/types/db";

// Writer: submit one rating. service_role only; dealer identity comes from the cookie in the action.
export async function submitRating(
  dealerId: string, auctionId: string, score: number, comment: string | null
): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("submit_rating", {
    p_auction_id: auctionId, p_rater_dealer_id: dealerId, p_score: score, p_comment: comment,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "ok" ? { ok: true } : { ok: false, reason: data as string };
}

// Seller/buyer reputation for a set of dealers, one row each. Read via the caller's client.
export async function getDealersReputation(
  sb: SupabaseClient, dealerIds: string[]
): Promise<DealerReputation[]> {
  if (!dealerIds.length) return [];
  const { data } = await sb.rpc("get_dealers_reputation", { p_dealer_ids: dealerIds });
  return (data ?? []) as DealerReputation[];
}

// Visible reviews about a dealer, newest first.
export async function getDealerReviews(sb: SupabaseClient, dealerId: string): Promise<DealerReview[]> {
  const { data } = await sb.rpc("get_dealer_reviews", { p_dealer_id: dealerId });
  return (data ?? []) as DealerReview[];
}

// Rate-panel state for one viewer on one auction (returns a single row, or null if unknown).
export async function getRatingState(
  sb: SupabaseClient, auctionId: string, viewerId: string
): Promise<RatingState | null> {
  const { data } = await sb.rpc("get_rating_state", {
    p_auction_id: auctionId, p_viewer_dealer_id: viewerId,
  });
  const row = Array.isArray(data) ? data[0] : data;
  return (row as RatingState) ?? null;
}
