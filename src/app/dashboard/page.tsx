import Link from "next/link";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { DashboardSection } from "@/components/DashboardSection";
import { DiscardDraftButton } from "@/components/DiscardDraftButton";
import { UnpublishButton } from "@/components/UnpublishButton";
import { WithdrawButton } from "@/components/WithdrawButton";
import { getMyListings, getMyBiddingAuctions, getMyWins, getMySales } from "@/lib/dashboard";
import { getMyWatching } from "@/lib/discovery";
import { closeExpiredAuctions } from "@/lib/auctions";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}

export default async function DashboardPage() {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");

  const sb = await serverClient();
  await closeExpiredAuctions(sb); // resolve expired auctions so My sales / My wins are current
  const [listings, bidding, wins, sales, watching] = await Promise.all([
    getMyListings(sb, dealerId),
    getMyBiddingAuctions(sb, dealerId),
    getMyWins(sb, dealerId),
    getMySales(sb, dealerId),
    getMyWatching(sb, dealerId),
  ]);

  // NOTE: the "flex items-center justify-between" classes are load-bearing —
  // e2e specs locate dashboard rows by `div.flex.items-center.justify-between`.
  const rowClass = "flex items-center justify-between rounded-lg border border-line bg-panel px-4 py-3 transition-colors";
  const linkRowClass = `${rowClass} hover:border-signal/40`;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-4xl px-6 py-8 space-y-8">
        <h1 className="font-display text-2xl font-bold text-chalk">My activity</h1>

        <DashboardSection title="My listings" count={listings.length} empty="You haven't listed any vehicles yet.">
          {listings.map((a: any) => (
            <div key={a.id} className={rowClass}>
              <Link href={`/auction/${a.id}`} className="text-chalk transition-colors hover:text-signal">{vehicleLabel(a.vehicle)}</Link>
              <span className="flex items-center gap-3">
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-fog">{a.status}</span>
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
                {a.status === "live" && a.current_bid == null && <UnpublishButton auctionId={a.id} />}
                {a.status === "live" && a.current_bid != null && <WithdrawButton auctionId={a.id} />}
              </span>
            </div>
          ))}
        </DashboardSection>

        <DashboardSection title="Bidding on" count={bidding.length} empty="You're not bidding on anything right now.">
          {bidding.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={linkRowClass}>
              <span className="text-chalk">{vehicleLabel(a.vehicle)}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono tabular-nums text-fog">{formatNZD(a.current_bid ?? a.starting_price)}</span>
                <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${a.current_winner_dealer_id === dealerId ? "text-go" : "text-stop"}`}>
                  {a.current_winner_dealer_id === dealerId ? "Winning" : "Outbid"}
                </span>
              </span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="My wins" count={wins.length} empty="No auctions won yet.">
          {wins.map((a: any) => (
            <Link key={a.id} href={`/won/${a.id}`} className={linkRowClass}>
              <span className="text-chalk">{vehicleLabel(a.vehicle)}</span>
              <span className="font-mono tabular-nums text-go">{formatNZD(a.current_bid ?? a.starting_price)}</span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="My sales" count={sales.length} empty="No completed sales yet.">
          {sales.map((a: any) => {
            const s = Array.isArray(a.settlement) ? a.settlement[0] : a.settlement;
            return (
              <Link key={a.id} href={`/auction/${a.id}`} className={linkRowClass}>
                <span className="text-chalk">{vehicleLabel(a.vehicle)}</span>
                <span className="text-sm">
                  {a.status === "sold" && s
                    ? <span className="font-mono tabular-nums text-go">{formatNZD(s.sale_price)}</span>
                    : <span className="text-fog">Passed in</span>}
                </span>
              </Link>
            );
          })}
        </DashboardSection>

        <DashboardSection title="Watching" count={watching.length} empty="You're not watching any auctions.">
          {watching.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={linkRowClass}>
              <span className="text-chalk">{vehicleLabel(a.vehicle)}</span>
              <span className="font-mono tabular-nums text-fog">{formatNZD(a.current_bid ?? a.starting_price)}</span>
            </Link>
          ))}
        </DashboardSection>
      </main>
    </>
  );
}
