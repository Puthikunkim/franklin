import Link from "next/link";
import { Auction, Vehicle, Dealer } from "@/types/db";
import { formatNZD } from "@/lib/money";
import { CountdownTimer } from "./CountdownTimer";
import { DealerBadge } from "./DealerBadge";
import { GradeStamp } from "./GradeStamp";
import { WatchButton } from "./WatchButton";

type AuctionWithJoins = Auction & {
  vehicle: Vehicle;
  seller: Dealer;
};

export function AuctionCard({
  auction,
  watched = false,
}: {
  auction: AuctionWithJoins;
  watched?: boolean;
}) {
  const { vehicle, seller } = auction;
  const displayPrice = auction.current_bid ?? auction.starting_price;
  const photoUrl = vehicle.photo_urls?.[0] ?? null;

  return (
    <div className="group relative">
      <div className="absolute left-2 top-2 z-10">
        <WatchButton auctionId={auction.id} watched={watched} />
      </div>

      <Link
        href={`/auction/${auction.id}`}
        className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-signal/40"
      >
        <div className="relative flex h-44 items-center justify-center bg-panel-2">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="font-mono text-xs uppercase tracking-widest text-fog">
              No photo
            </span>
          )}
          <span className="absolute right-2 top-2">
            <GradeStamp grade={vehicle.grade} />
          </span>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="font-display text-base font-semibold leading-tight text-chalk">
              {vehicle.year} {vehicle.make} {vehicle.model}
              {vehicle.variant ? (
                <span className="font-normal text-fog"> {vehicle.variant}</span>
              ) : null}
            </h2>
            <p className="mt-0.5 font-mono text-xs text-fog">
              {vehicle.odometer_km.toLocaleString("en-NZ")} km
              {vehicle.color ? ` · ${vehicle.color}` : ""}
            </p>
          </div>

          {/* Readout bar — the lot's live instrument line */}
          <div className="flex items-end justify-between border-t border-line pt-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog">
                {auction.current_bid ? "Current bid" : "Starting"}
              </p>
              <p className="font-mono text-xl font-bold tabular-nums text-signal">
                {formatNZD(displayPrice)}
              </p>
            </div>
            <span className="flex items-center gap-1.5 pb-0.5">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 animate-live rounded-full bg-signal"
              />
              <CountdownTimer endTime={auction.end_time} />
            </span>
          </div>

          <DealerBadge dealer={seller} />
        </div>
      </Link>
    </div>
  );
}
