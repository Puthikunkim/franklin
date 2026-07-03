import { serviceClient } from "@/lib/supabase/service";
import { validateListing, ListingInput, ValidationErrors } from "./validation";

export type ServiceResult =
  | { ok: true; auctionId: string }
  | { ok: false; errors: ValidationErrors & { _form?: string } };

function rpcArgs(input: ListingInput) {
  return {
    p_make: input.make, p_model: input.model, p_year: input.year, p_variant: input.variant,
    p_odometer_km: input.odometerKm, p_grade: input.grade, p_color: input.color,
    p_mechanical_notes: input.mechanicalNotes, p_appraisal_notes: input.appraisalNotes,
    p_photo_urls: input.photoUrls, p_starting_price: input.startingPrice,
    p_reserve_price: input.reservePrice, p_buy_now_price: input.buyNowPrice,
    p_end_time: input.endTime,
  };
}

export async function createDraft(dealerId: string, input: ListingInput): Promise<ServiceResult> {
  const errors = validateListing(input);
  if (Object.keys(errors).length) return { ok: false, errors };
  const { data, error } = await serviceClient().rpc("create_draft_listing", {
    p_dealer_id: dealerId, ...rpcArgs(input),
  });
  if (error) return { ok: false, errors: { _form: "Could not save draft" } };
  return { ok: true, auctionId: data as string };
}

export async function updateDraft(dealerId: string, auctionId: string, input: ListingInput): Promise<ServiceResult> {
  const errors = validateListing(input);
  if (Object.keys(errors).length) return { ok: false, errors };
  const { data, error } = await serviceClient().rpc("update_draft_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId, ...rpcArgs(input),
  });
  if (error) return { ok: false, errors: { _form: "Could not update draft" } };
  if (data !== "updated") return { ok: false, errors: { _form: data as string } };
  return { ok: true, auctionId };
}

export async function publishListing(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("publish_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "live" ? { ok: true } : { ok: false, reason: data as string };
}

export async function discardDraft(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("discard_draft_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "discarded" ? { ok: true } : { ok: false, reason: data as string };
}
