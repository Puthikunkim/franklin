import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Auction, Vehicle, Settlement } from "@/types/db";

type AuctionWithVehicle = Auction & { vehicle: Vehicle };

export default async function WonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15+: params is a Promise
  const { id } = await params;

  const currentDealerId = await getDealerId();
  if (!currentDealerId) redirect("/login");

  const sb = await serverClient();

  // Call close_auction RPC — idempotent; sets status to sold/passed if past end_time
  const { data: rpcResult, error: rpcError } = await sb.rpc("close_auction", {
    p_auction_id: id,
  });

  if (rpcError) {
    // Auction not found or bad UUID
    notFound();
  }

  const closeStatus = rpcResult as string | null;

  // Auction still live
  if (closeStatus === "live") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-lg font-semibold text-chalk">Auction still in progress.</p>
        <Link
          href={`/auction/${id}`}
          className="mt-4 inline-block text-sm text-fog transition-colors hover:text-chalk"
        >
          ← Back to auction
        </Link>
      </main>
    );
  }

  // Fetch auction with vehicle
  const { data: auctionRaw } = await sb
    .from("auctions")
    .select("*, vehicle:vehicles(*)")
    .eq("id", id)
    .single();

  if (!auctionRaw) notFound();

  const auction = auctionRaw as AuctionWithVehicle;
  const { vehicle } = auction;

  // PASSED — reserve not met
  if (auction.status === "passed") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-1 text-sm text-fog transition-colors hover:text-chalk"
        >
          ← Back to auctions
        </Link>

        <div className="space-y-4 rounded-xl border border-line bg-panel p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-signal/40 bg-signal/10">
            <span className="text-2xl text-signal">—</span>
          </div>
          <h1 className="font-display text-2xl font-bold text-chalk">Reserve not met — passed in</h1>
          <p className="text-fog">
            {vehicle.year} {vehicle.make} {vehicle.model}
            {vehicle.variant ? ` ${vehicle.variant}` : ""}
          </p>
          {auction.current_bid != null && (
            <p className="font-mono text-sm text-fog">
              Highest bid: {formatNZD(auction.current_bid)}
            </p>
          )}
        </div>
      </main>
    );
  }

  // SOLD — fetch settlement row
  const { data: settlementRaw } = await sb
    .from("settlements")
    .select("*")
    .eq("auction_id", id)
    .single();

  if (!settlementRaw) notFound();

  const settlement = settlementRaw as Settlement;

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <Link
        href="/"
        className="mb-8 inline-flex items-center gap-1 text-sm text-fog transition-colors hover:text-chalk"
      >
        ← Back to auctions
      </Link>

      <div className="space-y-6 rounded-xl border border-go/40 bg-panel p-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-go/40 bg-go/15">
            <svg
              className="h-5 w-5 text-go"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-chalk">Settlement arranged</h1>
            <p className="text-sm text-go">Auction sold</p>
          </div>
        </div>

        {/* Vehicle */}
        <div className="border-t border-line pt-5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-fog">Vehicle</p>
          <p className="text-lg font-semibold text-chalk">
            {vehicle.year} {vehicle.make} {vehicle.model}
            {vehicle.variant ? (
              <span className="font-normal text-fog"> {vehicle.variant}</span>
            ) : null}
          </p>
          <p className="mt-0.5 font-mono text-sm text-fog">
            {vehicle.odometer_km.toLocaleString("en-NZ")} km
            {vehicle.color ? ` · ${vehicle.color}` : ""}
            {vehicle.rego ? ` · ${vehicle.rego}` : ""}
          </p>
        </div>

        {/* Fee breakdown */}
        <div className="space-y-3 border-t border-line pt-5">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-fog">Settlement summary</p>

          <div className="flex items-baseline justify-between">
            <span className="text-sm text-chalk">Sale price</span>
            <span className="font-mono text-xl font-bold tabular-nums text-go">
              {formatNZD(settlement.sale_price)}
            </span>
          </div>

          <div className="flex items-baseline justify-between text-sm">
            <span className="text-fog">Seller fee</span>
            <span className="font-mono tabular-nums text-chalk">{formatNZD(settlement.seller_fee)}</span>
          </div>

          <div className="flex items-baseline justify-between text-sm">
            <span className="text-fog">Buyer fee</span>
            <span className="font-mono tabular-nums text-chalk">{formatNZD(settlement.buyer_fee)}</span>
          </div>
        </div>

        {/* Status pill */}
        <div className="border-t border-line pt-5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-go/40 bg-go/15 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-go">
            <span className="h-1.5 w-1.5 rounded-full bg-go" />
            {settlement.status.charAt(0).toUpperCase() + settlement.status.slice(1)}
          </span>
        </div>
      </div>
    </main>
  );
}
