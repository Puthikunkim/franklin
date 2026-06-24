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
        <p className="text-lg font-semibold text-zinc-300">Auction still in progress.</p>
        <Link
          href={`/auction/${id}`}
          className="mt-4 inline-block text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
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
          className="mb-8 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          ← Back to auctions
        </Link>

        <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-8 text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-900/40 border border-amber-700">
            <span className="text-2xl">—</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Reserve not met — passed in</h1>
          <p className="text-zinc-400">
            {vehicle.year} {vehicle.make} {vehicle.model}
            {vehicle.variant ? ` ${vehicle.variant}` : ""}
          </p>
          {auction.current_bid != null && (
            <p className="text-sm text-zinc-500">
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
        className="mb-8 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        ← Back to auctions
      </Link>

      <div className="rounded-xl border border-emerald-700 bg-zinc-800/50 p-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-900/50 border border-emerald-700">
            <svg
              className="h-5 w-5 text-emerald-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Settlement arranged</h1>
            <p className="text-sm text-emerald-400">Auction sold</p>
          </div>
        </div>

        {/* Vehicle */}
        <div className="border-t border-zinc-700 pt-5">
          <p className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Vehicle</p>
          <p className="text-lg font-semibold text-white">
            {vehicle.year} {vehicle.make} {vehicle.model}
            {vehicle.variant ? (
              <span className="font-normal text-zinc-400"> {vehicle.variant}</span>
            ) : null}
          </p>
          <p className="text-sm text-zinc-400 mt-0.5">
            {vehicle.odometer_km.toLocaleString("en-NZ")} km
            {vehicle.color ? ` · ${vehicle.color}` : ""}
            {vehicle.rego ? ` · ${vehicle.rego}` : ""}
          </p>
        </div>

        {/* Fee breakdown */}
        <div className="border-t border-zinc-700 pt-5 space-y-3">
          <p className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Settlement summary</p>

          <div className="flex justify-between items-baseline">
            <span className="text-sm text-zinc-300">Sale price</span>
            <span className="text-xl font-bold text-white font-mono tabular-nums">
              {formatNZD(settlement.sale_price)}
            </span>
          </div>

          <div className="flex justify-between items-baseline text-sm">
            <span className="text-zinc-400">Seller fee</span>
            <span className="text-zinc-200">{formatNZD(settlement.seller_fee)}</span>
          </div>

          <div className="flex justify-between items-baseline text-sm">
            <span className="text-zinc-400">Buyer fee</span>
            <span className="text-zinc-200">{formatNZD(settlement.buyer_fee)}</span>
          </div>
        </div>

        {/* Status pill */}
        <div className="border-t border-zinc-700 pt-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/40 border border-emerald-700 px-3 py-1 text-xs font-semibold text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {settlement.status.charAt(0).toUpperCase() + settlement.status.slice(1)}
          </span>
        </div>
      </div>
    </main>
  );
}
