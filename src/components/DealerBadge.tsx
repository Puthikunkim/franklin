import { Dealer, DealerReputation } from "@/types/db";

export function DealerBadge({
  dealer,
  reputation,
}: {
  dealer: Dealer;
  reputation?: DealerReputation | null;
}) {
  const hasScore = reputation && reputation.seller_count > 0;
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fog">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-ink font-mono text-[10px] font-bold uppercase text-signal">
        {dealer.initials}
      </span>
      <span className="max-w-[140px] truncate text-chalk">{dealer.business_name}</span>
      {dealer.is_verified && (
        <span className="text-go" title="Verified">✓</span>
      )}
      {hasScore ? (
        <span className="font-mono text-signal">★ {Number(reputation!.seller_avg).toFixed(1)}</span>
      ) : (
        <span className="font-mono text-fog">New</span>
      )}
    </span>
  );
}
