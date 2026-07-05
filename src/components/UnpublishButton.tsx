"use client";

import { useActionState, useState } from "react";
import { unpublishAction } from "@/app/dashboard/actions";

export function UnpublishButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(unpublishAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs text-amber-400 hover:text-amber-300">
        Unpublish
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-zinc-400">Unpublish to draft?</span>
      <button type="submit" disabled={pending} className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50">
        {pending ? "…" : "Yes"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="text-xs text-zinc-400 hover:text-zinc-200">
        No
      </button>
      {state.error && <span className="text-xs text-red-400">{state.error}</span>}
    </form>
  );
}
