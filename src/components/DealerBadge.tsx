import { Dealer } from "@/types/db";

export function DealerBadge({ dealer }: { dealer: Dealer }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fog">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-ink font-mono text-[10px] font-bold uppercase text-signal">
        {dealer.initials}
      </span>
      <span className="max-w-[140px] truncate text-chalk">{dealer.business_name}</span>
      {dealer.is_verified && (
        <span className="text-go" title="Verified">✓</span>
      )}
    </span>
  );
}
