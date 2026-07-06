import Link from "next/link";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { getUnreadCount } from "@/lib/notifications";

export async function Header() {
  const dealerId = await getDealerId();
  let unread = 0;
  if (dealerId) {
    const sb = await serverClient();
    unread = await getUnreadCount(sb, dealerId);
  }
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <Link href="/" className="font-semibold text-white">Wholesale Dealer Auctions</Link>
      {dealerId && (
        <nav className="flex items-center gap-2">
          <Link
            href="/notifications"
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            className="relative rounded px-3 py-1.5 text-sm font-medium text-zinc-200 hover:text-white"
          >
            <span aria-hidden="true">🔔</span>
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                {unread}
              </span>
            )}
          </Link>
          <Link href="/dashboard" className="rounded px-3 py-1.5 text-sm font-medium text-zinc-200 hover:text-white">
            Dashboard
          </Link>
          <Link href="/sell" className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
            Sell a vehicle
          </Link>
        </nav>
      )}
    </header>
  );
}
