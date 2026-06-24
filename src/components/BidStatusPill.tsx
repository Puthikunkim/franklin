export type BidStatus = "winning" | "outbid" | "reserve" | "ended";

const CONFIG: Record<BidStatus, { label: string; className: string }> = {
  winning: {
    label: "Winning",
    className: "bg-emerald-900/60 text-emerald-300 border border-emerald-700",
  },
  outbid: {
    label: "Outbid",
    className: "bg-red-900/60 text-red-300 border border-red-700",
  },
  reserve: {
    label: "Reserve not met",
    className: "bg-amber-900/60 text-amber-300 border border-amber-700",
  },
  ended: {
    label: "Auction ended",
    className: "bg-zinc-800 text-zinc-400 border border-zinc-600",
  },
};

export function BidStatusPill({ status }: { status: BidStatus }) {
  const { label, className } = CONFIG[status];
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${className}`}
    >
      {label}
    </span>
  );
}
