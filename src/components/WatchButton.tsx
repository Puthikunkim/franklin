"use client";

import { useActionState } from "react";
import { toggleWatchAction } from "@/lib/watch/actions";

export function WatchButton({ auctionId, watched }: { auctionId: string; watched: boolean }) {
  const [state, action, pending] = useActionState(toggleWatchAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="auctionId" value={auctionId} />
      {/* carry the TARGET state: clicking flips current → opposite */}
      <input type="hidden" name="watched" value={watched ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        aria-pressed={watched}
        aria-label={watched ? "Unwatch" : "Watch"}
        title={watched ? "Unwatch" : "Watch"}
        className={`rounded-full bg-zinc-900/80 px-2 py-1 text-base leading-none disabled:opacity-50 ${
          watched ? "text-red-400" : "text-zinc-300 hover:text-red-300"
        }`}
      >
        {watched ? "♥" : "♡"}
      </button>
      {state.error && <span className="sr-only">{state.error}</span>}
    </form>
  );
}
