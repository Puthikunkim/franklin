import { Dealer } from "@/types/db";

export function DealerBadge({ dealer }: { dealer: Dealer }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-700 px-2.5 py-1 text-xs text-zinc-200">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-500 text-[10px] font-bold uppercase text-white">
        {dealer.initials}
      </span>
      <span className="truncate max-w-[120px]">{dealer.business_name}</span>
      {dealer.is_verified && (
        <span className="text-blue-400" title="Verified">✓</span>
      )}
    </span>
  );
}
