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
  // Every surface that shows watch state must be revalidated: the home grid
  // (card hearts), the dashboard "Watching" section, and the auction detail
  // page's own WatchButton. Omitting the detail path leaves a stale button
  // when arriving there via a prefetched/cached client navigation.
  revalidatePath("/");
  revalidatePath("/dashboard");
  if (auctionId) revalidatePath(`/auction/${auctionId}`);
  return {};
}
