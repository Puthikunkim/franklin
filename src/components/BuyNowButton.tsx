"use client";

import { useActionState, useState } from "react";
import { buyNowAction } from "@/lib/purchase/actions";
import { formatNZD } from "@/lib/money";

export function BuyNowButton({ auctionId, buyNowPrice }: { auctionId: string; buyNowPrice: number }) {
  const [state, action, pending] = useActionState(buyNowAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-3 text-sm font-semibold text-white"
      >
        Buy now for {formatNZD(buyNowPrice)}
      </button>
    );
  }

  return (
    <form action={action} className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 space-y-3">
      <input type="hidden" name="auctionId" value={auctionId} />
      <p className="text-sm text-zinc-200">
        Buy now for {formatNZD(buyNowPrice)}? You&apos;ll pay a $20 buyer fee.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Buying…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
