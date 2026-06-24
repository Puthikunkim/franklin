import { getDealerId } from "@/lib/session";
import { redirect } from "next/navigation";
import { getLiveAuctions } from "@/lib/auctions";
import { AuctionCard } from "@/components/AuctionCard";
import { Header } from "@/components/Header";

export default async function Home() {
  if (!(await getDealerId())) redirect("/login");
  const auctions = await getLiveAuctions();
  return (
    <main className="mx-auto max-w-6xl p-6">
      <Header />
      <h1 className="text-2xl font-semibold mb-6">Live auctions</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {auctions.map((a) => (
          <AuctionCard key={a.id} auction={a as Parameters<typeof AuctionCard>[0]["auction"]} />
        ))}
      </div>
    </main>
  );
}
