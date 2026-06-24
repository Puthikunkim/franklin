"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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

  const ended = isAuctionEnded(auctionStatus, endTime);

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
          const updated = payload.new;
          const newBid = updated.current_bid ?? currentBid;
          const newWinner = updated.current_winner_dealer_id ?? null;
          const newEndTime = updated.end_time ?? endTime;
          const newStatus = updated.status ?? auctionStatus;

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

          setCurrentBid(newBid);
          setWinner(newWinner);
          setEndTime(newEndTime);
          setAuctionStatus(newStatus);
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
        (payload: { new: Bid }) => {
          const newBid = payload.new as BidWithDealer;
          setBids((prev) => [newBid, ...prev]);
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
        } else if (reason === "reserve_not_met") {
          setMsg("Bid placed but reserve price not yet met.");
          setMsgType("info");
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
      ? "text-emerald-400"
      : msgType === "err"
      ? "text-red-400"
      : "text-zinc-300";

  return (
    <div className="space-y-6">
      {/* Bid Panel */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              {auction.current_bid ? "Current bid" : "Starting price"}
            </p>
            <p className="text-4xl font-mono font-bold tabular-nums text-white">
              {formatNZD(currentBid)}
            </p>
          </div>
          <BidStatusPill status={pillStatus} />
        </div>

        {auction.reserve_price > 0 && (
          <p className="text-xs text-zinc-500">
            Reserve:{" "}
            <span className={currentBid >= auction.reserve_price ? "text-emerald-400" : "text-amber-400"}>
              {currentBid >= auction.reserve_price ? "Met" : "Not met"}
            </span>
          </p>
        )}

        {outbidAlert && (
          <div className="rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300 font-medium">
            You have been outbid!
          </div>
        )}

        {ended ? (
          <p className="text-sm text-zinc-500 font-medium">This auction has ended.</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="max-bid" className="text-xs text-zinc-400 font-medium">
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
                className="w-full rounded-lg bg-zinc-900 border border-zinc-600 px-3 py-2.5 text-white placeholder-zinc-600 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
              />
            </div>

            <button
              onClick={placeBid}
              disabled={loading || !maxInput}
              className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 px-4 py-3 font-semibold text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Placing bid…" : "Place bid"}
            </button>
          </div>
        )}

        {msg && <p className={`text-sm ${msgColor}`}>{msg}</p>}
      </div>

      {/* Bid History */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">
          Bid history
        </h3>
        <BidHistory bids={bids} />
      </div>
    </div>
  );
}
