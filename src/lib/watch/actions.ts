"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { setWatch } from "@/lib/watch/service";

export async function toggleWatchAction(
  _prev: { error?: string },
  formData: FormData
): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const watched = String(formData.get("watched")) === "true";
  const r = await setWatch(dealerId, auctionId, watched);
  if (!r.ok) return { error: "Could not update your watchlist, try again." };
  revalidatePath("/");
  revalidatePath("/dashboard");
  return {};
}
