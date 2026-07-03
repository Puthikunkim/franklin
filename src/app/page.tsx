import { getDealerId } from "@/lib/session";
import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { searchLiveAuctions, parseFilters } from "@/lib/discovery";
import { AuctionCard } from "@/components/AuctionCard";
import { FilterBar } from "@/components/FilterBar";
import { Header } from "@/components/Header";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await getDealerId())) redirect("/login");

  const filters = parseFilters(await searchParams);
  const sb = await serverClient();
  const auctions = await searchLiveAuctions(sb, filters);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Header />
      <h1 className="text-2xl font-semibold mb-6">Live auctions</h1>
      <FilterBar />
      {auctions.length === 0 ? (
        <p className="text-zinc-400">No auctions match your filters.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {auctions.map((a) => (
            <AuctionCard
              key={a.id}
              auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
            />
          ))}
        </div>
      )}
    </main>
  );
}
