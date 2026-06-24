"use client";

import { useActionState } from "react";
import Link from "next/link";
import { publishAction } from "@/app/sell/actions";

export function PublishPanel({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(publishAction, {});
  return (
    <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-6 space-y-4">
      <div className="text-amber-300 text-sm font-semibold">Draft — not yet live</div>
      <p className="text-sm text-zinc-300">Review the details. Publishing starts the auction now and makes it visible to all dealers.</p>
      <div className="flex gap-3">
        <form action={action}>
          <input type="hidden" name="auctionId" value={auctionId} />
          <button type="submit" disabled={pending}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-semibold text-white disabled:opacity-50">
            {pending ? "Publishing…" : "Publish auction"}</button>
        </form>
        <Link href={`/sell/${auctionId}`} className="rounded border border-zinc-600 px-4 py-2 text-sm text-zinc-200">Edit draft</Link>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
