"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { discardDraft } from "@/lib/listings/service";

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
