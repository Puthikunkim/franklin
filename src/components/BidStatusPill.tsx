export type BidStatus = "winning" | "outbid" | "reserve" | "ended";

const CONFIG: Record<BidStatus, { label: string; className: string }> = {
  winning: {
    label: "Winning",
    className: "border border-go/40 bg-go/15 text-go",
  },
  outbid: {
    label: "Outbid",
    className: "border border-stop/40 bg-stop/15 text-stop",
  },
  reserve: {
    label: "Reserve not met",
    className: "border border-signal/40 bg-signal/15 text-signal",
  },
  ended: {
    label: "Auction ended",
    className: "border border-line bg-panel-2 text-fog",
  },
};

export function BidStatusPill({ status }: { status: BidStatus }) {
  const { label, className } = CONFIG[status];
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${className}`}
    >
      {label}
    </span>
  );
}
