import { getDealerId } from "@/lib/session";
import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { searchLiveAuctions, parseFilters, getWatchedAuctionIds } from "@/lib/discovery";
import { closeExpiredAuctions } from "@/lib/auctions";
import { getDealersReputation } from "@/lib/ratings";
import { AuctionCard } from "@/components/AuctionCard";
import { FilterBar } from "@/components/FilterBar";
import { Header } from "@/components/Header";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");

  const filters = parseFilters(await searchParams);
  const sb = await serverClient();
  await closeExpiredAuctions(sb); // resolve any expired auctions before querying the grid
  const [auctions, watchedIds] = await Promise.all([
    searchLiveAuctions(sb, filters),
    getWatchedAuctionIds(sb, dealerId),
  ]);
  const watched = new Set(watchedIds);
  const sellerIds = [...new Set(auctions.map((a) => (a as { seller_dealer_id: string }).seller_dealer_id))];
  const reps = await getDealersReputation(sb, sellerIds);
  const repBySeller = new Map(reps.map((r) => [r.dealer_id, r]));

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Header />
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-fog">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-live rounded-full bg-signal" />
            Trading floor
          </p>
          <h1 className="font-display text-3xl font-bold tracking-tight text-chalk">Live auctions</h1>
        </div>
        <p className="font-mono text-sm text-fog">
          <span className="text-chalk">{auctions.length}</span> {auctions.length === 1 ? "lot" : "lots"} live
        </p>
      </div>
      <FilterBar />
      {auctions.length === 0 ? (
        <p className="text-fog">No auctions match your filters.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {auctions.map((a) => (
            <AuctionCard
              key={a.id}
              auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
              watched={watched.has(a.id)}
              sellerReputation={repBySeller.get((a as { seller_dealer_id: string }).seller_dealer_id) ?? null}
            />
          ))}
        </div>
      )}
    </main>
  );
}
