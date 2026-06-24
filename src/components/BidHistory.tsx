import { Bid, Dealer } from "@/types/db";
import { formatNZD } from "@/lib/money";

type BidWithDealer = Bid & { dealer?: Pick<Dealer, "business_name"> | null };

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortId(id: string): string {
  return id.slice(0, 6).toUpperCase();
}

export function BidHistory({ bids }: { bids: BidWithDealer[] }) {
  if (bids.length === 0) {
    return (
      <p className="text-sm text-zinc-500 py-4 text-center">No bids yet.</p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-700 bg-zinc-800/60 text-zinc-400 text-xs uppercase tracking-wide">
            <th className="px-4 py-2 text-left">Amount</th>
            <th className="px-4 py-2 text-left">Dealer</th>
            <th className="px-4 py-2 text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {bids.map((bid, i) => (
            <tr
              key={bid.id}
              className={`border-b border-zinc-700/50 last:border-0 ${
                i === 0 ? "bg-zinc-700/30" : ""
              }`}
            >
              <td className="px-4 py-3 font-mono font-semibold text-white">
                {formatNZD(bid.amount)}
              </td>
              <td className="px-4 py-3 text-zinc-300">
                {bid.dealer?.business_name ?? shortId(bid.bidder_dealer_id)}
              </td>
              <td className="px-4 py-3 text-right text-zinc-500 font-mono text-xs">
                {formatTime(bid.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
