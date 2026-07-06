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
        className="w-full rounded-lg bg-signal px-4 py-3 text-sm font-semibold text-ink transition-colors hover:bg-signal/90"
      >
        Buy now for {formatNZD(buyNowPrice)}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-signal/40 bg-signal/10 p-4">
      <input type="hidden" name="auctionId" value={auctionId} />
      <p className="text-sm text-chalk">
        Buy now for {formatNZD(buyNowPrice)}? You&apos;ll pay a $20 buyer fee.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-signal px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-signal/90 disabled:opacity-50"
        >
          {pending ? "Buying…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md px-3 py-1.5 text-sm text-fog transition-colors hover:text-chalk"
        >
          Cancel
        </button>
      </div>
      {state.error && <p className="text-sm text-stop">{state.error}</p>}
    </form>
  );
}
