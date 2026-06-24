import Link from "next/link";
import { Auction, Vehicle, Dealer } from "@/types/db";
import { formatNZD } from "@/lib/money";
import { CountdownTimer } from "./CountdownTimer";
import { DealerBadge } from "./DealerBadge";

type AuctionWithJoins = Auction & {
  vehicle: Vehicle;
  seller: Dealer;
};

export function AuctionCard({ auction }: { auction: AuctionWithJoins }) {
  const { vehicle, seller } = auction;
  const displayPrice = auction.current_bid ?? auction.starting_price;
  const photoUrl = vehicle.photo_urls?.[0] ?? null;

  return (
    <Link
      href={`/auction/${auction.id}`}
      className="group flex flex-col rounded-xl bg-zinc-800 overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors"
    >
      <div className="relative h-44 bg-zinc-700 flex items-center justify-center">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-zinc-500 text-sm">No photo</span>
        )}
        <span className="absolute top-2 right-2 rounded bg-zinc-900/80 px-2 py-0.5 text-xs font-semibold text-zinc-200">
          Grade {vehicle.grade}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <h2 className="text-base font-semibold text-zinc-100 leading-tight">
          {vehicle.year} {vehicle.make} {vehicle.model}
          {vehicle.variant ? <span className="font-normal text-zinc-400"> {vehicle.variant}</span> : null}
        </h2>
        <p className="text-xs text-zinc-400">
          {vehicle.odometer_km.toLocaleString("en-NZ")} km
          {vehicle.color ? ` · ${vehicle.color}` : ""}
        </p>

        <div className="flex items-center justify-between mt-1">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">
              {auction.current_bid ? "Current bid" : "Starting price"}
            </p>
            <p className="text-lg font-bold text-white">{formatNZD(displayPrice)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Ends in</p>
            <CountdownTimer endTime={auction.end_time} />
          </div>
        </div>

        <div className="mt-2">
          <DealerBadge dealer={seller} />
        </div>
      </div>
    </Link>
  );
}
