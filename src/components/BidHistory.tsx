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
      <p className="py-4 text-center text-sm text-fog">No bids yet.</p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-panel font-mono text-[10px] uppercase tracking-[0.12em] text-fog">
            <th className="px-4 py-2 text-left font-semibold">Amount</th>
            <th className="px-4 py-2 text-left font-semibold">Dealer</th>
            <th className="px-4 py-2 text-right font-semibold">Time</th>
          </tr>
        </thead>
        <tbody>
          {bids.map((bid, i) => (
            <tr
              key={bid.id}
              className={`border-b border-line/60 last:border-0 ${
                i === 0 ? "bg-signal/5" : ""
              }`}
            >
              <td
                className={`px-4 py-3 font-mono font-semibold tabular-nums ${
                  i === 0 ? "text-signal" : "text-chalk"
                }`}
              >
                {formatNZD(bid.amount)}
              </td>
              <td className="px-4 py-3 text-fog">
                {bid.dealer?.business_name ?? shortId(bid.bidder_dealer_id)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs text-fog">
                {formatTime(bid.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
