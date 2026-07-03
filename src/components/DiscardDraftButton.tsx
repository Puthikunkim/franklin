"use client";

import { useActionState, useState } from "react";
import { discardDraftAction } from "@/app/dashboard/actions";

export function DiscardDraftButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(discardDraftAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs text-red-400 hover:text-red-300">
        Discard
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-zinc-400">Discard draft?</span>
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
