import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Auction, Vehicle, Dealer, Bid } from "@/types/db";
import { BidPanel } from "@/components/BidPanel";
import { CountdownTimer } from "@/components/CountdownTimer";
import { DealerBadge } from "@/components/DealerBadge";

type AuctionRow = Auction & {
  vehicle: Vehicle;
  seller: Dealer;
};

type BidRow = Bid & { dealer: Pick<Dealer, "business_name"> | null };

export default async function AuctionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15+: params is a Promise
  const { id } = await params;

  const currentDealerId = await getDealerId();
  if (!currentDealerId) redirect("/login");

  const sb = await serverClient();

  // Fetch the auction with vehicle + seller (using FK-disambiguated join)
  const { data: auction } = await sb
    .from("auctions")
    .select("*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)")
    .eq("id", id)
    .single();

  if (!auction) notFound();

  const typed = auction as AuctionRow;

  // Fetch bids newest first, with the bidder's dealer record
  const { data: bidsRaw } = await sb
    .from("bids")
    .select("*, dealer:dealers!bids_bidder_dealer_id_fkey(business_name)")
    .eq("auction_id", id)
    .order("created_at", { ascending: false });

  const bids: BidRow[] = (bidsRaw ?? []) as BidRow[];

  const { vehicle, seller } = typed;
  const displayPrice = typed.current_bid ?? typed.starting_price;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* Back nav */}
      <a
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        ← Back to auctions
      </a>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left column: vehicle details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Photo */}
          <div className="relative overflow-hidden rounded-xl bg-zinc-800 h-72 flex items-center justify-center">
            {vehicle.photo_urls?.[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={vehicle.photo_urls[0]}
                alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-zinc-500">No photo available</span>
            )}
            <span className="absolute top-3 right-3 rounded-full bg-zinc-900/80 px-3 py-1 text-xs font-semibold text-zinc-200">
              Grade {vehicle.grade}
            </span>
          </div>

          {/* Vehicle title */}
          <div>
            <h1 className="text-2xl font-bold text-white leading-tight">
              {vehicle.year} {vehicle.make} {vehicle.model}
              {vehicle.variant ? (
                <span className="font-normal text-zinc-400"> {vehicle.variant}</span>
              ) : null}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {vehicle.odometer_km.toLocaleString("en-NZ")} km
              {vehicle.color ? ` · ${vehicle.color}` : ""}
              {vehicle.rego ? ` · ${vehicle.rego}` : ""}
            </p>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Starting price" value={formatNZD(typed.starting_price)} />
            <Stat label="Current bid" value={formatNZD(displayPrice)} highlight />
            <Stat label="Bid increment" value={formatNZD(typed.bid_increment)} />
            {typed.buy_now_price ? (
              <Stat label="Buy now" value={formatNZD(typed.buy_now_price)} />
            ) : null}
          </div>

          {/* Countdown */}
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <span>Time remaining:</span>
            <CountdownTimer endTime={typed.end_time} />
          </div>

          {/* Notes */}
          {vehicle.mechanical_notes && (
            <div className="rounded-lg bg-zinc-800/60 border border-zinc-700 p-4">
              <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2 font-semibold">
                Mechanical notes
              </h3>
              <p className="text-sm text-zinc-300 whitespace-pre-line">{vehicle.mechanical_notes}</p>
            </div>
          )}

          {vehicle.appraisal_notes && (
            <div className="rounded-lg bg-zinc-800/60 border border-zinc-700 p-4">
              <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2 font-semibold">
                Appraisal notes
              </h3>
              <p className="text-sm text-zinc-300 whitespace-pre-line">{vehicle.appraisal_notes}</p>
            </div>
          )}

          {/* Seller */}
          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2 font-semibold">
              Seller
            </h3>
            <DealerBadge dealer={seller} />
          </div>
        </div>

        {/* Right column: bid panel */}
        <div className="lg:col-span-1">
          <BidPanel
            auction={typed}
            currentDealerId={currentDealerId}
            initialBids={bids}
          />
        </div>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg bg-zinc-800/60 border border-zinc-700 p-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{label}</p>
      <p className={`text-base font-bold ${highlight ? "text-white" : "text-zinc-200"}`}>
        {value}
      </p>
    </div>
  );
}
