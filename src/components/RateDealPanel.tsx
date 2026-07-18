"use client";

import { useActionState, useState } from "react";
import type { RatingState } from "@/types/db";
import { submitRatingAction } from "@/app/auction/actions";
import { Stars } from "@/components/Stars";

export function RateDealPanel({ auctionId, state }: { auctionId: string; state: RatingState }) {
  const [result, action, pending] = useActionState(submitRatingAction, {});
  const [score, setScore] = useState(0);

  if (!state.eligible) return null;

  const wrap = "rounded-xl border border-line bg-panel p-4 space-y-3";
  const heading = (
    <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">Rate this deal</h3>
  );

  // Already revealed: show both sides.
  if (state.revealed) {
    return (
      <div className={wrap}>
        {heading}
        {state.my_score != null && (
          <p className="flex items-center justify-between text-sm text-chalk">
            <span>You rated</span><Stars score={state.my_score} />
          </p>
        )}
        {state.counterpart_score != null ? (
          <div className="border-t border-line pt-3">
            <p className="flex items-center justify-between text-sm text-chalk">
              <span>They rated</span><Stars score={state.counterpart_score} />
            </p>
            {state.counterpart_comment && <p className="mt-1.5 text-sm text-fog">{state.counterpart_comment}</p>}
          </div>
        ) : (
          <p className="text-sm text-fog">The other dealer did not leave a rating.</p>
        )}
      </div>
    );
  }

  // Submitted but still blind.
  if (state.already_rated) {
    return (
      <div className={wrap}>
        {heading}
        <p className="text-sm text-fog">
          Rating submitted. It stays hidden until the other dealer rates or the 14-day window closes.
        </p>
      </div>
    );
  }

  // Window closed without a rating from this dealer.
  if (!state.window_open) {
    return (
      <div className={wrap}>
        {heading}
        <p className="text-sm text-fog">The rating window has closed.</p>
      </div>
    );
  }

  // Open form.
  return (
    <form action={action} className={wrap}>
      {heading}
      <input type="hidden" name="auctionId" value={auctionId} />
      <input type="hidden" name="score" value={score} />
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Rate ${n} ${n === 1 ? "star" : "stars"}`}
            onClick={() => setScore(n)}
            className={`text-2xl transition-colors ${n <= score ? "text-signal" : "text-line hover:text-fog"}`}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        name="comment"
        maxLength={280}
        placeholder="Optional note (how did the deal go?)"
        className="w-full rounded-lg border border-line bg-panel-2 p-2 text-sm text-chalk placeholder:text-fog focus:border-signal/40 focus:outline-none"
        rows={3}
      />
      <button
        type="submit"
        disabled={pending || score === 0}
        className="w-full rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {pending ? "Submitting…" : "Submit rating"}
      </button>
      {result.error && <p className="text-xs text-stop">{result.error}</p>}
    </form>
  );
}
