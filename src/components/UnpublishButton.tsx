"use client";

import { useActionState, useState } from "react";
import { unpublishAction } from "@/app/dashboard/actions";

export function UnpublishButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(unpublishAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs font-medium text-signal transition-colors hover:text-signal/80">
        Unpublish
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-fog">Unpublish to draft?</span>
      <button type="submit" disabled={pending} className="text-xs font-medium text-signal transition-colors hover:text-signal/80 disabled:opacity-50">
        {pending ? "…" : "Yes"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="text-xs text-fog transition-colors hover:text-chalk">
        No
      </button>
      {state.error && <span className="text-xs text-stop">{state.error}</span>}
    </form>
  );
}
