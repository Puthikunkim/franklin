import Link from "next/link";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { listNotifications, getEndingSoonWatched, markNotificationsRead } from "@/lib/notifications";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}

const LABEL: Record<string, (v: string) => string> = {
  outbid: (v) => `You were outbid on ${v}`,
  won: (v) => `You won ${v}`,
  sold: (v) => `Your ${v} sold`,
  withdrawn: (v) => `An auction you bid on was withdrawn — ${v}`,
};

function hrefFor(type: string, auctionId: string): string {
  return type === "won" ? `/won/${auctionId}` : `/auction/${auctionId}`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function NotificationsPage() {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const sb = await serverClient();

  const [rows, endingSoon] = await Promise.all([
    listNotifications(sb, dealerId),
    getEndingSoonWatched(sb, dealerId),
  ]);
  // Capture which rows were unread THIS visit (for the "New" highlight) before clearing.
  const wasUnread = new Set(rows.filter((r: any) => r.read_at == null).map((r: any) => r.id));
  // Clear the unread badge for next time — mutation during render, same pattern /won uses.
  await markNotificationsRead(dealerId);

  const rowClass = "flex items-center justify-between rounded border px-4 py-3";

  return (
    <>
      <Header />
      <main className="mx-auto max-w-2xl px-6 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-white">Notifications</h1>

        {endingSoon.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Ending soon</h2>
            {endingSoon.map((a: any) => (
              <Link key={a.id} href={`/auction/${a.id}`} className={`${rowClass} border-amber-700 bg-amber-950/30`}>
                <span className="text-white">{vehicleLabel(a.vehicle)}</span>
                <span className="font-mono text-amber-300">{formatNZD(a.current_bid ?? a.starting_price)}</span>
              </Link>
            ))}
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Recent</h2>
          {rows.length === 0 && endingSoon.length === 0 && (
            <p className="text-zinc-500">You have no notifications yet.</p>
          )}
          {rows.map((r: any) => {
            const label = (LABEL[r.type] ?? ((v: string) => v))(vehicleLabel(r.auction.vehicle));
            const isNew = wasUnread.has(r.id);
            return (
              <Link
                key={r.id}
                href={hrefFor(r.type, r.auction_id)}
                className={`${rowClass} ${isNew ? "border-emerald-700 bg-emerald-950/20" : "border-zinc-800 bg-zinc-900/50"}`}
              >
                <span className="text-white">{label}</span>
                <span className="flex items-center gap-3">
                  {isNew && <span className="text-[10px] uppercase tracking-wide text-emerald-400">New</span>}
                  <span className="text-xs text-zinc-500">{timeAgo(r.created_at)}</span>
                </span>
              </Link>
            );
          })}
        </section>
      </main>
    </>
  );
}
