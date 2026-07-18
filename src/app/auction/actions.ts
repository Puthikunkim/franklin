"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { submitRating } from "@/lib/ratings";

const MESSAGES: Record<string, string> = {
  not_sold: "This auction isn't a completed sale.",
  not_party: "Only the buyer and seller can rate this deal.",
  window_closed: "The rating window has closed.",
  already_rated: "You've already rated this deal.",
  bad_score: "Choose a score from 1 to 5.",
  error: "Could not submit rating, try again.",
};

export async function submitRatingAction(
  _prev: { error?: string }, formData: FormData
): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const score = Number(formData.get("score") || 0);
  const comment = String(formData.get("comment") || "").trim() || null;
  const r = await submitRating(dealerId, auctionId, score, comment);
  if (r.ok) {
    revalidatePath(`/auction/${auctionId}`);
    return {};
  }
  return { error: MESSAGES[r.reason ?? "error"] ?? "Could not submit rating." };
}
