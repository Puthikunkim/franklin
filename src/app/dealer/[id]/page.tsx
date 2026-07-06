import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { AuctionCard } from "@/components/AuctionCard";
import { getWatchedAuctionIds } from "@/lib/discovery";
import { getDealer, getDealerLiveListings, getDealerSales } from "@/lib/dealers";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}
function soldDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

export default async function DealerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const viewerId = await getDealerId();
  if (!viewerId) redirect("/login");
  const { id } = await params;

  const sb = await serverClient();
  const dealer = await getDealer(sb, id);
  if (!dealer) notFound();

  const [listings, sales, watchedIds] = await Promise.all([
    getDealerLiveListings(sb, id),
    getDealerSales(sb, id),
    getWatchedAuctionIds(sb, viewerId),
  ]);
  const watched = new Set(watchedIds);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-6 py-8 space-y-8">
        {/* Trust header */}
        <section className="flex items-start gap-4 rounded-xl border border-line bg-panel p-6">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-ink font-mono text-lg font-bold uppercase text-signal">
            {dealer.initials}
          </span>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl font-bold text-chalk">{dealer.business_name}</h1>
              {dealer.is_verified && <span className="text-go" title="Verified">✓</span>}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-fog">
              <span className="text-signal">★ {Number(dealer.rating).toFixed(1)}</span>
              <span>{dealer.region}</span>
              <span>Licence {dealer.dealer_license_no}</span>
            </div>
            <p className="text-sm text-chalk">
              {sales.length} completed {sales.length === 1 ? "sale" : "sales"}
            </p>
          </div>
        </section>

        {/* Live listings */}
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-chalk">Live listings</h2>
          {listings.length === 0 ? (
            <p className="text-fog">No live listings right now.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {listings.map((a) => (
                <AuctionCard
                  key={a.id}
                  auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
                  watched={watched.has(a.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Sales history */}
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-chalk">Sales history</h2>
          {sales.length === 0 ? (
            <p className="text-fog">No completed sales yet.</p>
          ) : (
            <div className="space-y-2">
              {sales.map((a) => {
                const s = Array.isArray(a.settlement) ? a.settlement[0] : a.settlement;
                return (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-lg border border-line bg-panel px-4 py-3"
                  >
                    <span className="text-chalk">{vehicleLabel(a.vehicle)}</span>
                    <span className="flex items-center gap-4 text-sm">
                      <span className="font-mono text-fog">{soldDate(a.end_time)}</span>
                      <span className="font-mono tabular-nums text-go">{s ? formatNZD(s.sale_price) : "—"}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
