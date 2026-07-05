import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { formatNZD } from "@/lib/money";
import { Bid, Dealer } from "@/types/db";
import { BidPanel } from "@/components/BidPanel";
import { PublishPanel } from "@/components/PublishPanel";
import { CountdownTimer } from "@/components/CountdownTimer";
import { DealerBadge } from "@/components/DealerBadge";
import { getAuctionById } from "@/lib/auctions";
import { serverClient } from "@/lib/supabase/server";
import { getWatchedAuctionIds } from "@/lib/discovery";
import { WatchButton } from "@/components/WatchButton";
import { Header } from "@/components/Header";
import { BuyNowButton } from "@/components/BuyNowButton";

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

  const auction = await getAuctionById(id);
  if (!auction) notFound();

  const isDraft = auction.status === "draft";

  // Drafts are private: only the owner may view them
  if (isDraft && auction.seller_dealer_id !== currentDealerId) notFound();

  // For live auctions, fetch bids; skip entirely for drafts
  let bids: BidRow[] = [];
  if (!isDraft) {
    const sb = await serverClient();
    const { data: bidsRaw } = await sb
      .from("bids")
      .select("*, dealer:dealers!bids_bidder_dealer_id_fkey(business_name)")
      .eq("auction_id", id)
      .order("created_at", { ascending: false });
    bids = (bidsRaw ?? []) as BidRow[];
  }

  // Watch state for live auctions (drafts are not watchable).
  let isWatched = false;
  if (!isDraft) {
    const sbWatch = await serverClient();
    isWatched = (await getWatchedAuctionIds(sbWatch, currentDealerId)).includes(id);
  }

  const { vehicle, seller } = auction;
  const displayPrice = auction.current_bid ?? auction.starting_price;

  // Right-hand panel: PublishPanel for owner's draft, BidPanel otherwise
  const rightPanel = isDraft ? (
    <PublishPanel auctionId={auction.id} />
  ) : (
    <BidPanel
      auction={auction}
      currentDealerId={currentDealerId}
      initialBids={bids}
    />
  );

  // Buy-now is offered only on a live auction that still has no bids, has a
  // buy-now price, and is being viewed by someone other than the seller.
  const canBuyNow =
    !isDraft &&
    auction.status === "live" &&
    auction.buy_now_price != null &&
    auction.current_bid == null &&
    auction.seller_dealer_id !== currentDealerId;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <Header />
      {/* Back nav */}
      <a
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        ← Back to auctions
      </a>

      {isDraft && (
        <div className="mb-4 rounded-lg bg-amber-950/40 border border-amber-700 px-4 py-2 text-sm text-amber-300 font-medium">
          Draft — not yet live
        </div>
      )}

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
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-2xl font-bold text-white leading-tight">
                {vehicle.year} {vehicle.make} {vehicle.model}
                {vehicle.variant ? (
                  <span className="font-normal text-zinc-400"> {vehicle.variant}</span>
                ) : null}
              </h1>
              {!isDraft && <WatchButton auctionId={auction.id} watched={isWatched} />}
            </div>
            <p className="mt-1 text-sm text-zinc-400">
              {vehicle.odometer_km.toLocaleString("en-NZ")} km
              {vehicle.color ? ` · ${vehicle.color}` : ""}
              {vehicle.rego ? ` · ${vehicle.rego}` : ""}
            </p>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Starting price" value={formatNZD(auction.starting_price)} />
            {!isDraft && <Stat label="Current bid" value={formatNZD(displayPrice)} highlight />}
            <Stat label="Bid increment" value={formatNZD(auction.bid_increment)} />
            {auction.buy_now_price ? (
              <Stat label="Buy now" value={formatNZD(auction.buy_now_price)} />
            ) : null}
          </div>

          {/* Countdown — only meaningful for live auctions */}
          {!isDraft && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span>Time remaining:</span>
              <CountdownTimer endTime={auction.end_time} />
            </div>
          )}

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

        {/* Right column: buy-now (when eligible) above the publish/bid panel */}
        <div className="lg:col-span-1 space-y-4">
          {canBuyNow && (
            <BuyNowButton auctionId={auction.id} buyNowPrice={auction.buy_now_price!} />
          )}
          {rightPanel}
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
