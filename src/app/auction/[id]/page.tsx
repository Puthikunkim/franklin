import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { formatNZD } from "@/lib/money";
import { Bid, Dealer } from "@/types/db";
import { BidPanel } from "@/components/BidPanel";
import { PublishPanel } from "@/components/PublishPanel";
import { CountdownTimer } from "@/components/CountdownTimer";
import { DealerBadge } from "@/components/DealerBadge";
import { GradeStamp } from "@/components/GradeStamp";
import { getAuctionById } from "@/lib/auctions";
import { serverClient } from "@/lib/supabase/server";
import { getWatchedAuctionIds } from "@/lib/discovery";
import { WatchButton } from "@/components/WatchButton";
import { Header } from "@/components/Header";
import { BuyNowButton } from "@/components/BuyNowButton";
import { RateDealPanel } from "@/components/RateDealPanel";
import { getRatingState } from "@/lib/ratings";

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
  const isCancelled = auction.status === "cancelled";

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

  // Rating is offered only on a completed sale, to the buyer or the seller.
  const sbRating = await serverClient();
  const ratingState =
    auction.status === "sold" ? await getRatingState(sbRating, id, currentDealerId) : null;

  // Right-hand panel: PublishPanel for owner's draft, BidPanel otherwise
  const rightPanel = isDraft ? (
    <PublishPanel auctionId={auction.id} />
  ) : isCancelled ? null : (
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
        className="mb-6 inline-flex items-center gap-1 text-sm text-fog transition-colors hover:text-chalk"
      >
        ← Back to auctions
      </a>

      {isDraft && (
        <div className="mb-4 rounded-lg border border-signal/40 bg-signal/10 px-4 py-2 text-sm font-medium text-signal">
          Draft — not yet live
        </div>
      )}

      {isCancelled && (
        <div className="mb-4 rounded-lg border border-stop/40 bg-stop/10 px-4 py-2 text-sm font-medium text-stop">
          This auction was withdrawn by the seller.
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left column: vehicle details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Photo */}
          <div className="relative flex h-72 items-center justify-center overflow-hidden rounded-xl border border-line bg-panel">
            {vehicle.photo_urls?.[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={vehicle.photo_urls[0]}
                alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="font-mono text-xs uppercase tracking-widest text-fog">No photo available</span>
            )}
            <span className="absolute right-3 top-3">
              <GradeStamp grade={vehicle.grade} />
            </span>
          </div>

          {/* Vehicle title */}
          <div>
            <div className="flex items-start justify-between gap-3">
              <h1 className="font-display text-2xl font-bold leading-tight text-chalk">
                {vehicle.year} {vehicle.make} {vehicle.model}
                {vehicle.variant ? (
                  <span className="font-normal text-fog"> {vehicle.variant}</span>
                ) : null}
              </h1>
              {!isDraft && <WatchButton auctionId={auction.id} watched={isWatched} />}
            </div>
            <p className="mt-1 font-mono text-sm text-fog">
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
          {!isDraft && !isCancelled && (
            <div className="flex items-center gap-2 font-mono text-sm text-fog">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 animate-live rounded-full bg-signal"
              />
              <span className="uppercase tracking-[0.12em] text-[11px]">Time remaining</span>
              <CountdownTimer endTime={auction.end_time} />
            </div>
          )}

          {/* Notes */}
          {vehicle.mechanical_notes && (
            <div className="rounded-lg border border-line bg-panel p-4">
              <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
                Mechanical notes
              </h3>
              <p className="whitespace-pre-line text-sm text-chalk">{vehicle.mechanical_notes}</p>
            </div>
          )}

          {vehicle.appraisal_notes && (
            <div className="rounded-lg border border-line bg-panel p-4">
              <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
                Appraisal notes
              </h3>
              <p className="whitespace-pre-line text-sm text-chalk">{vehicle.appraisal_notes}</p>
            </div>
          )}

          {/* Seller */}
          <div>
            <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
              Seller
            </h3>
            <Link href={`/dealer/${seller.id}`} className="inline-block transition-opacity hover:opacity-80">
              <DealerBadge dealer={seller} />
            </Link>
          </div>
        </div>

        {/* Right column: buy-now (when eligible) above the publish/bid panel */}
        <div className="lg:col-span-1 space-y-4">
          {canBuyNow && (
            <BuyNowButton auctionId={auction.id} buyNowPrice={auction.buy_now_price!} />
          )}
          {ratingState?.eligible && (
            <RateDealPanel auctionId={auction.id} state={ratingState} />
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
    <div className="rounded-lg border border-line bg-panel p-3">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-fog">{label}</p>
      <p className={`font-mono text-base font-bold tabular-nums ${highlight ? "text-signal" : "text-chalk"}`}>
        {value}
      </p>
    </div>
  );
}
