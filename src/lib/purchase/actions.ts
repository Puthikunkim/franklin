"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { buyNow } from "@/lib/purchase/service";

const BUY_NOW_MESSAGES: Record<string, string> = {
  has_bids: "Bidding has started — buy now is no longer available.",
  is_seller: "You can't buy your own listing.",
  no_buy_now: "This listing has no buy-now price.",
  sold: "This auction is no longer available.",
  ended: "This auction is no longer available.",
  passed: "This auction is no longer available.",
  draft: "This auction is no longer available.",
  not_found: "This auction is no longer available.",
  error: "Could not complete the purchase, try again.",
};

export async function buyNowAction(
  _prev: { error?: string },
  formData: FormData
): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await buyNow(dealerId, auctionId);
  if (r.ok) {
    // Revalidate every surface the sale changes, then show the settlement.
    revalidatePath("/");
    revalidatePath("/dashboard");
    revalidatePath(`/auction/${auctionId}`);
    redirect(`/won/${auctionId}`); // throws NEXT_REDIRECT — nothing after runs on success
  }
  return { error: BUY_NOW_MESSAGES[r.reason ?? "error"] ?? "Could not complete the purchase." };
}
