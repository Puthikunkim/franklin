import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";

export const ENDING_SOON_MINUTES = 30;

// A dealer's stored notifications (outbid/won/sold), newest first, each joined to its
// auction + vehicle for rendering. Read via the caller's client (anon on the page).
export async function listNotifications(sb: SupabaseClient, dealerId: string): Promise<any[]> {
  const { data } = await sb
    .from("notifications")
    .select("*, auction:auctions(*, vehicle:vehicles(*))")
    .eq("recipient_dealer_id", dealerId)
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}

// The dealer's watched auctions that are still live and end within the next N minutes,
// ending-soonest first. Derived on-read — no stored rows, no scheduler. Filtered in JS
// (a dealer watches only a handful) rather than via embedded-resource filters.
export async function getEndingSoonWatched(sb: SupabaseClient, dealerId: string): Promise<any[]> {
  const now = Date.now();
  const soon = now + ENDING_SOON_MINUTES * 60000;
  const { data } = await sb
    .from("watchlist")
    .select("auction:auctions(*, vehicle:vehicles(*))")
    .eq("dealer_id", dealerId);
  return (data ?? [])
    .map((r: { auction: any }) => r.auction)
    .filter((a: any) => a && a.status === "live")
    .filter((a: any) => {
      const t = new Date(a.end_time).getTime();
      return t > now && t <= soon;
    })
    .sort((a: any, b: any) => new Date(a.end_time).getTime() - new Date(b.end_time).getTime());
}

// Badge count: unread stored notifications + watched auctions currently ending soon.
export async function getUnreadCount(sb: SupabaseClient, dealerId: string): Promise<number> {
  const { count } = await sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_dealer_id", dealerId)
    .is("read_at", null);
  const endingSoon = await getEndingSoonWatched(sb, dealerId);
  return (count ?? 0) + endingSoon.length;
}

// Writer: mark all of the dealer's unread notifications read. service_role-only (server).
export async function markNotificationsRead(dealerId: string): Promise<void> {
  await serviceClient().rpc("mark_notifications_read", { p_dealer_id: dealerId });
}
