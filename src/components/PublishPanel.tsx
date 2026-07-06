"use client";

import { useActionState } from "react";
import Link from "next/link";
import { publishAction } from "@/app/sell/actions";

export function PublishPanel({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(publishAction, {});
  return (
    <div className="space-y-4 rounded-xl border border-signal/40 bg-signal/10 p-6">
      <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-signal">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-signal" />
        Draft — not yet live
      </div>
      <p className="text-sm text-fog">Review the details. Publishing starts the auction now and makes it visible to all dealers.</p>
      <div className="flex gap-3">
        <form action={action}>
          <input type="hidden" name="auctionId" value={auctionId} />
          <button type="submit" disabled={pending}
            className="rounded-md bg-signal px-4 py-2 font-semibold text-ink transition-colors hover:bg-signal/90 disabled:opacity-50">
            {pending ? "Publishing…" : "Publish auction"}</button>
        </form>
        <Link href={`/sell/${auctionId}`} className="rounded-md border border-line px-4 py-2 text-sm text-chalk transition-colors hover:border-signal/40">Edit draft</Link>
      </div>
      {state.error && <p className="text-sm text-stop">{state.error}</p>}
    </div>
  );
}
