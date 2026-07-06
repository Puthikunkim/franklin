"use client";

import { useActionState, useState } from "react";
import { discardDraftAction } from "@/app/dashboard/actions";

export function DiscardDraftButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(discardDraftAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs font-medium text-stop transition-colors hover:text-stop/80">
        Discard
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-fog">Discard draft?</span>
      <button type="submit" disabled={pending} className="text-xs font-medium text-stop transition-colors hover:text-stop/80 disabled:opacity-50">
        {pending ? "…" : "Yes"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="text-xs text-fog transition-colors hover:text-chalk">
        No
      </button>
      {state.error && <span className="text-xs text-stop">{state.error}</span>}
    </form>
  );
}
