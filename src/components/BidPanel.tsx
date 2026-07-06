"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { browserClient } from "@/lib/supabase/client";
import { formatNZD } from "@/lib/money";
import { BidStatusPill, BidStatus } from "./BidStatusPill";
import { BidHistory } from "./BidHistory";
import { Auction, Bid, Dealer } from "@/types/db";

type BidWithDealer = Bid & { dealer?: Pick<Dealer, "business_name"> | null };

type AuctionWithJoins = Auction & {
  vehicle: { make: string; model: string; year: number };
  seller: Dealer;
};

interface BidPanelProps {
  auction: AuctionWithJoins;
  currentDealerId: string;
  initialBids: BidWithDealer[];
}

function isAuctionEnded(status: string, endTime: string): boolean {
  return status === "ended" || status === "sold" || status === "passed" || new Date(endTime).getTime() <= Date.now();
}

export function BidPanel({ auction, currentDealerId, initialBids }: BidPanelProps) {
  const [currentBid, setCurrentBid] = useState<number>(
    auction.current_bid ?? auction.starting_price
  );
  const [winner, setWinner] = useState<string | null>(auction.current_winner_dealer_id);
  const [endTime, setEndTime] = useState<string>(auction.end_time);
  const [auctionStatus, setAuctionStatus] = useState<string>(auction.status);
  const [bids, setBids] = useState<BidWithDealer[]>(initialBids);
  const [maxInput, setMaxInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"ok" | "err" | "info">("info");
  const [loading, setLoading] = useState(false);
  const [outbidAlert, setOutbidAlert] = useState(false);

  // Track previous winner to detect outbid
  const prevWinnerRef = useRef<string | null>(winner);

  const [timerEnded, setTimerEnded] = useState(false);
  const ended = isAuctionEnded(auctionStatus, endTime) || timerEnded;

  // Derive the bid status pill state
  const derivePillStatus = useCallback(
    (bid: number, winnerDealerId: string | null, status: string, et: string): BidStatus => {
      if (isAuctionEnded(status, et)) return "ended";
      if (winnerDealerId === null) return "outbid"; // no bids yet, not winning
      if (winnerDealerId === currentDealerId) {
        return bid >= auction.reserve_price ? "winning" : "reserve";
      }
      return "outbid";
    },
    [currentDealerId, auction.reserve_price]
  );

  const pillStatus = derivePillStatus(currentBid, winner, auctionStatus, endTime);

  // Refetch current state (used on channel reconnect)
  const refetchState = useCallback(async () => {
    const sb = browserClient();
    const { data: auctionData } = await sb
      .from("auctions")
      .select("current_bid, current_winner_dealer_id, end_time, status")
      .eq("id", auction.id)
      .single();
    if (auctionData) {
      setCurrentBid(auctionData.current_bid ?? auction.starting_price);
      setWinner(auctionData.current_winner_dealer_id);
      setEndTime(auctionData.end_time);
      setAuctionStatus(auctionData.status);
    }

    const { data: bidsData } = await sb
      .from("bids")
      .select("*, dealer:dealers!bids_bidder_dealer_id_fkey(business_name)")
      .eq("auction_id", auction.id)
      .order("created_at", { ascending: false });
    if (bidsData) setBids(bidsData as BidWithDealer[]);
  }, [auction.id, auction.starting_price]);

  // Set up realtime subscription
  useEffect(() => {
    const sb = browserClient();

    const channel = sb
      .channel(`auction-detail-${auction.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "auctions",
          filter: `id=eq.${auction.id}`,
        },
        (payload: { new: Partial<Auction> }) => {
          // Only apply fields actually present in the payload. Depending on the
          // table's REPLICA IDENTITY a payload may omit unchanged columns; never
          // fall back to mount-time closure values (those would silently revert state).
          const updated = payload.new;

          if ("current_winner_dealer_id" in updated) {
            const newWinner = updated.current_winner_dealer_id ?? null;
            // Detect outbid: we were winning, now we're not
            if (
              prevWinnerRef.current === currentDealerId &&
              newWinner !== currentDealerId &&
              newWinner !== null
            ) {
              setOutbidAlert(true);
              setTimeout(() => setOutbidAlert(false), 5000);
            }
            prevWinnerRef.current = newWinner;
            setWinner(newWinner);
          }
          if (updated.current_bid != null) setCurrentBid(updated.current_bid);
          if (updated.end_time != null) setEndTime(updated.end_time);
          if (updated.status != null) setAuctionStatus(updated.status);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "bids",
          filter: `auction_id=eq.${auction.id}`,
        },
        async (payload: { new: Bid }) => {
          // The realtime payload is the raw bids row with no dealer join, so look
          // up the bidder's business name before showing it — otherwise a live
          // rival bid renders as a hashed short-id while refreshed rows show names.
          const raw = payload.new;
          const sb2 = browserClient();
          const { data: dealer } = await sb2
            .from("dealers")
            .select("business_name")
            .eq("id", raw.bidder_dealer_id)
            .single();
          const enriched: BidWithDealer = { ...raw, dealer: dealer ?? null };
          setBids((prev) =>
            prev.some((b) => b.id === enriched.id) ? prev : [enriched, ...prev]
          );
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("Realtime channel error, refetching state:", err);
          refetchState();
        }
      });

    return () => {
      sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auction.id]);

  // One-shot timer: flip ended state when end_time passes (catches the case where
  // the realtime UPDATE hasn't arrived yet because status hasn't been set to sold/passed).
  useEffect(() => {
    const ms = new Date(endTime).getTime() - Date.now();
    if (ms <= 0) {
      setTimerEnded(true);
      return;
    }
    const t = setTimeout(() => setTimerEnded(true), ms);
    return () => clearTimeout(t);
  }, [endTime]);

  async function placeBid() {
    const dollars = Number(maxInput);
    if (!maxInput || !Number.isFinite(dollars) || dollars <= 0) {
      setMsg("Enter a valid bid amount in dollars.");
      setMsgType("err");
      return;
    }
    const maxAmount = Math.round(dollars * 100);

    setLoading(true);
    setMsg(null);
    setOutbidAlert(false);

    try {
      const res = await fetch("/api/place-bid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auctionId: auction.id, maxAmount }),
      });

      if (res.status === 401) {
        setMsg("You must be logged in to bid.");
        setMsgType("err");
        return;
      }

      const r = await res.json();

      if (r.status === "accepted") {
        setMsg("Bid placed successfully.");
        setMsgType("ok");
        setMaxInput("");
        // Reconcile state from API response
        if (r.current_bid !== undefined) setCurrentBid(r.current_bid);
        if (r.current_winner_dealer_id !== undefined) setWinner(r.current_winner_dealer_id);
        if (r.end_time !== undefined) setEndTime(r.end_time);
        prevWinnerRef.current = r.current_winner_dealer_id ?? null;
      } else {
        const reason = r.reason ?? r.error ?? "unknown";
        if (reason === "below_minimum") {
          setMsg(`Bid too low. Minimum bid is ${formatNZD(currentBid + auction.bid_increment)}.`);
        } else if (reason === "auction_ended") {
          setMsg("This auction has already ended.");
          setAuctionStatus("ended");
        } else {
          setMsg(`Bid rejected: ${reason}`);
        }
        setMsgType("err");
      }
    } catch (e) {
      console.error(e);
      setMsg("Network error. Please try again.");
      setMsgType("err");
    } finally {
      setLoading(false);
    }
  }

  const msgColor =
    msgType === "ok"
      ? "text-go"
      : msgType === "err"
      ? "text-stop"
      : "text-fog";

  return (
    <div className="space-y-6">
      {/* Instrument cluster — the live bid readout */}
      <div className="space-y-4 rounded-xl border border-line bg-panel p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-fog">
              {!ended && (
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 animate-live rounded-full bg-signal"
                />
              )}
              {auction.current_bid ? "Current bid" : "Starting price"}
            </p>
            <p className="text-4xl font-mono font-bold tabular-nums text-signal">
              {formatNZD(currentBid)}
            </p>
          </div>
          <BidStatusPill status={pillStatus} />
        </div>

        {auction.reserve_price > 0 && (
          <p className="font-mono text-xs text-fog">
            Reserve:{" "}
            <span className={currentBid >= auction.reserve_price ? "text-go" : "text-signal"}>
              {currentBid >= auction.reserve_price ? "Met" : "Not met"}
            </span>
          </p>
        )}

        {outbidAlert && (
          <div className="rounded-lg border border-stop/50 bg-stop/15 px-4 py-3 text-sm font-medium text-stop">
            You have been outbid!
          </div>
        )}

        {ended ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-fog">This auction has ended.</p>
            <Link
              href={`/won/${auction.id}`}
              className="block w-full rounded-lg border border-line bg-panel-2 px-4 py-3 text-center text-sm font-semibold text-chalk transition-colors hover:border-signal/40"
            >
              View result →
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="max-bid" className="text-xs font-medium text-fog">
                Your max bid (NZD $)
              </label>
              <input
                id="max-bid"
                value={maxInput}
                onChange={(e) => setMaxInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loading && placeBid()}
                inputMode="decimal"
                placeholder="e.g. 12500"
                disabled={loading}
                className="w-full rounded-lg border border-line bg-ink px-3 py-2.5 font-mono text-chalk placeholder-fog focus:border-signal focus:outline-none disabled:opacity-50"
              />
            </div>

            <button
              onClick={placeBid}
              disabled={loading || !maxInput}
              className="w-full rounded-lg bg-signal px-4 py-3 font-semibold text-ink transition-colors hover:bg-signal/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Placing bid…" : "Place bid"}
            </button>
          </div>
        )}

        {msg && <p className={`text-sm ${msgColor}`}>{msg}</p>}
      </div>

      {/* Bid History */}
      <div>
        <h3 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-fog">
          Bid history
        </h3>
        <BidHistory bids={bids} />
      </div>
    </div>
  );
}
