"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { discardDraft, unpublishListing, withdrawListing } from "@/lib/listings/service";

const DISCARD_MESSAGES: Record<string, string> = {
  not_owner: "You can only discard your own draft.",
  not_draft: "This listing is already published.",
  error: "Could not discard, try again.",
};

export async function discardDraftAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await discardDraft(dealerId, auctionId);
  if (r.ok) {
    revalidatePath("/dashboard");
    return {};
  }
  return { error: DISCARD_MESSAGES[r.reason ?? "error"] ?? "Could not discard." };
}

const UNPUBLISH_MESSAGES: Record<string, string> = {
  not_owner: "You can only unpublish your own listing.",
  not_live: "This listing isn't live.",
  has_bids: "This listing has bids and can't be unpublished.",
  error: "Could not unpublish, try again.",
};

export async function unpublishAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await unpublishListing(dealerId, auctionId);
  if (r.ok) {
    revalidatePath("/dashboard");
    revalidatePath("/");
    revalidatePath(`/auction/${auctionId}`);
    return {};
  }
  return { error: UNPUBLISH_MESSAGES[r.reason ?? "error"] ?? "Could not unpublish." };
}

const WITHDRAW_MESSAGES: Record<string, string> = {
  not_owner: "You can only withdraw your own listing.",
  not_live: "This listing isn't live.",
  no_bids: "This listing has no bids — unpublish it instead.",
  error: "Could not withdraw, try again.",
};

export async function withdrawAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await withdrawListing(dealerId, auctionId);
  if (r.ok) {
    revalidatePath("/dashboard");
    revalidatePath("/");
    revalidatePath(`/auction/${auctionId}`);
    return {};
  }
  return { error: WITHDRAW_MESSAGES[r.reason ?? "error"] ?? "Could not withdraw." };
}
