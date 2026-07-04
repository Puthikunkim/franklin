import Link from "next/link";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { DashboardSection } from "@/components/DashboardSection";
import { DiscardDraftButton } from "@/components/DiscardDraftButton";
import { getMyListings, getMyBiddingAuctions, getMyWins, getMySales } from "@/lib/dashboard";
import { getMyWatching } from "@/lib/discovery";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}

export default async function DashboardPage() {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");

  const sb = await serverClient();
  const [listings, bidding, wins, sales, watching] = await Promise.all([
    getMyListings(sb, dealerId),
    getMyBiddingAuctions(sb, dealerId),
    getMyWins(sb, dealerId),
    getMySales(sb, dealerId),
    getMyWatching(sb, dealerId),
  ]);

  const rowClass = "flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-4 py-3";

  return (
    <>
      <Header />
      <main className="mx-auto max-w-4xl px-6 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-white">My activity</h1>

        <DashboardSection title="My listings" count={listings.length} empty="You haven't listed any vehicles yet.">
          {listings.map((a: any) => (
            <div key={a.id} className={rowClass}>
              <Link href={`/auction/${a.id}`} className="text-white hover:underline">{vehicleLabel(a.vehicle)}</Link>
              <span className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wide text-zinc-400">{a.status}</span>
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
              </span>
            </div>
          ))}
        </DashboardSection>

        <DashboardSection title="Bidding on" count={bidding.length} empty="You're not bidding on anything right now.">
          {bidding.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-zinc-300">{formatNZD(a.current_bid ?? a.starting_price)}</span>
                <span className={a.current_winner_dealer_id === dealerId ? "text-emerald-400 text-xs" : "text-red-400 text-xs"}>
                  {a.current_winner_dealer_id === dealerId ? "Winning" : "Outbid"}
                </span>
              </span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="My wins" count={wins.length} empty="No auctions won yet.">
          {wins.map((a: any) => (
            <Link key={a.id} href={`/won/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="font-mono text-emerald-400">{formatNZD(a.current_bid ?? a.starting_price)}</span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="My sales" count={sales.length} empty="No completed sales yet.">
          {sales.map((a: any) => {
            const s = Array.isArray(a.settlement) ? a.settlement[0] : a.settlement;
            return (
              <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
                <span className="text-white">{vehicleLabel(a.vehicle)}</span>
                <span className="text-sm">
                  {a.status === "sold" && s
                    ? <span className="font-mono text-emerald-400">{formatNZD(s.sale_price)}</span>
                    : <span className="text-zinc-500">Passed in</span>}
                </span>
              </Link>
            );
          })}
        </DashboardSection>

        <DashboardSection title="Watching" count={watching.length} empty="You're not watching any auctions.">
          {watching.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="font-mono text-zinc-300">{formatNZD(a.current_bid ?? a.starting_price)}</span>
            </Link>
          ))}
        </DashboardSection>
      </main>
    </>
  );
}
