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
    <header className="mb-8 flex items-center justify-between border-b border-line px-6 py-4">
      <Link href="/" className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded bg-signal font-mono text-xs font-bold text-ink"
        >
          WD
        </span>
        <span className="hidden font-display text-sm font-semibold tracking-tight text-chalk sm:inline">
          Wholesale Dealer Auctions
        </span>
      </Link>
      {dealerId && (
        <nav className="flex items-center gap-1">
          <Link
            href="/notifications"
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            className="relative rounded-md px-3 py-1.5 text-base text-fog transition-colors hover:text-chalk"
          >
            <span aria-hidden="true">🔔</span>
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-stop px-1 font-mono text-[10px] font-bold text-ink">
                {unread}
              </span>
            )}
          </Link>
          <Link
            href="/dashboard"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-fog transition-colors hover:text-chalk"
          >
            Dashboard
          </Link>
          <Link
            href="/sell"
            className="rounded-md bg-signal px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-signal/90"
          >
            Sell a vehicle
          </Link>
        </nav>
      )}
    </header>
  );
}
