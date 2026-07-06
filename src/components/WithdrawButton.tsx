"use client";

import { useActionState, useState } from "react";
import { withdrawAction } from "@/app/dashboard/actions";

export function WithdrawButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(withdrawAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs text-red-400 hover:text-red-300">
        Withdraw
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-zinc-400">Withdraw &amp; cancel? Bidders are notified — can&apos;t be undone.</span>
      <button type="submit" disabled={pending} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
        {pending ? "…" : "Yes"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="text-xs text-zinc-400 hover:text-zinc-200">
        No
      </button>
      {state.error && <span className="text-xs text-red-400">{state.error}</span>}
    </form>
  );
}
