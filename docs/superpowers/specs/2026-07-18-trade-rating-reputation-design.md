# Trade rating / reputation system (Slice 12)

## Context and goal

Franklin is a dealer-only wholesale auction platform whose entire pitch is trust: verified dealers trading with confidence. Today that trust is faked. Every dealer carries a static `rating` column defaulting to `4.5`, and there is no way to earn, change or read a real reputation. This slice replaces the fake number with a real, earned reputation built from post-sale ratings between the two parties to each deal.

The feature is credential-free: it needs no external service (no Stripe, no email/SMS provider, no third-party API), so it can be built and tested entirely against the local Supabase stack the existing tests already use.

## Decisions locked in brainstorming

- **Direction and timing:** bidirectional, blind reveal. Both parties to a completed sale rate each other; neither sees the other's rating until both submit or the window closes. This prevents retaliatory ratings.
- **Rating shape:** one overall 1-5 star score plus an optional short comment (<=280 chars). One column to average, one line of colour.
- **Window:** a single 14-day window. After a sale both parties may rate. Ratings stay hidden until both submit (early reveal) or `now >= settled_at + 14 days`, whichever comes first, at which point whatever exists is revealed and locked and no further rating is allowed.
- **Display:** split seller-side and buyer-side scores, shown separately with counts. A dealer who is an accurate seller but a flaky buyer should read that way, not average out. New dealers show "No ratings yet", never a fake number.
- **Architecture:** derive on read. The raw rating rows are the single source of truth. Visibility and averages are computed at read time, with no scheduled reveal sweep and no denormalized aggregate columns that could drift. This matches how the app already derives state on read (for example the `closeExpiredAuctions()` call on page load).

## Data model

One new table, `ratings`, holding the raw rows:

```
ratings
  id                uuid primary key default gen_random_uuid()
  auction_id        uuid not null references auctions(id)   -- the settled sale
  rater_dealer_id   uuid not null references dealers(id)    -- who left it
  ratee_dealer_id   uuid not null references dealers(id)    -- who it is about
  direction         text not null check (direction in ('seller','buyer'))  -- the ratee's role being rated
  score             int  not null check (score between 1 and 5)
  comment           text check (comment is null or char_length(comment) <= 280)
  created_at        timestamptz not null default now()
  unique (auction_id, rater_dealer_id)          -- one rating per party per deal
```

`direction` records the role of the ratee being rated. When the buyer rates the seller, `direction = 'seller'` (rating the seller's seller-performance). When the seller rates the buyer, `direction = 'buyer'`. A dealer's seller-side score is the average of visible rows where `ratee_dealer_id = dealer and direction = 'seller'`; the buyer-side score is the same with `direction = 'buyer'`.

Two supporting schema changes:

- **`settlements` gains `created_at timestamptz not null default now()`.** The settlement row is inserted exactly at sale time inside `close_auction` / `buy_now_listing`, so its `created_at` is the anchor for the 14-day window. Nothing in the current schema timestamps the moment of sale.
- **`dealers.rating` is dropped.** The static `4.5` is removed along with its two readers: the `Dealer` TypeScript type (`src/types/db.ts`) and the dealer profile page (`src/app/dealer/[id]/page.tsx`), which currently renders `★ {dealer.rating}`. Reputation is always derived from `ratings` after this slice.

## Write path

New writer RPC, following the same security posture as the existing writers (`security definer`, granted to `service_role` only, revoked from `public`/`anon`/`authenticated`; the dealer identity comes from the httpOnly cookie in the server action, never from the browser):

```
submit_rating(p_auction_id uuid, p_rater_dealer_id uuid, p_score int, p_comment text)
  returns text
```

Guards, evaluated in order, each returning a result code:

1. Auction exists and `status = 'sold'`, else `not_sold`. Only sold auctions have a settled buyer/seller pair. Passed-in, cancelled and withdrawn auctions have no settlement and are never eligible.
2. `seller_dealer_id <> current_winner_dealer_id` and the rater is one of those two ids, else `not_party`. (The distinctness check also covers the degenerate case where a seller somehow won their own auction: only one party exists, so rating is not possible.)
3. The window is still open: `settlement.created_at + interval '14 days' > now()`, else `window_closed`.
4. No existing rating by this rater for this auction (the unique constraint also enforces this), else `already_rated`.

On passing all guards it derives `ratee_dealer_id` and `direction` from which side the rater is (rater is seller then ratee is the winner and `direction = 'buyer'`; rater is winner then ratee is the seller and `direction = 'seller'`), inserts the row, and returns `ok`.

Result codes: `ok | not_sold | not_party | window_closed | already_rated`.

Ratings are immutable once submitted. There is no edit flow (YAGNI): a dealer rates when ready.

**Settlement-time prompt.** Both `close_auction` and `buy_now_listing` emit a new `'rate'` notification to each party at the moment of sale ("Rate your deal"). This requires extending the `notifications.type` check constraint to allow `'rate'` and adding `'rate'` to the `NotificationType` union in `src/types/db.ts`. This is the same additive pattern migration 0011 used when it added its bidder-facing notification type. The `close_auction` path emits `'rate'` to both the winner and the seller; the `buy_now_listing` path does the same for the buyer and the seller.

## Read path (blind-safe, derive on read)

Blindness is a hard requirement: an unrevealed rating must not be readable by its counterparty. The `ratings` table is therefore **not** granted to `anon`/`authenticated` (only `service_role`). This is a deliberate departure from the open-read posture the app uses for `auctions`/`bids`/`notifications`, justified because those tables have nothing to hide whereas a blind rating does. All reads go through `security definer` functions so the visibility rule cannot be bypassed:

- `get_dealers_reputation(p_dealer_ids uuid[])` returns one row per requested dealer, `{dealer_id uuid, seller_avg numeric, seller_count int, buyer_avg numeric, buyer_count int}`, aggregated over **visible** rows only. The profile calls it with a single-element array; the auction grid calls it once with the distinct seller ids on the page, so there is no N+1 across cards.
- `get_dealer_reviews(p_dealer_id uuid)` returns the visible comments and scores (with direction and date) for the profile reviews list.
- `get_rating_state(p_auction_id uuid, p_viewer_dealer_id uuid)` returns what the rating panel needs: `{eligible bool, window_open bool, already_rated bool, counterpart_submitted bool, revealed bool, my_score int, my_comment text, counterpart_score int, counterpart_comment text}`. The counterpart's score/comment are returned only when `revealed` is true.

**The visibility rule is defined once and applied identically in every read.** A rating row is visible when the counterpart rating for the same auction exists (both parties submitted, so early reveal), or when `settlement.created_at + interval '14 days' <= now()` (the window has elapsed). Averages and reviews aggregate only over visible rows. Because visibility is derived, the numbers are always current with no sweep and no reveal lag.

These read functions are called server-side (in server components and actions) with the viewer id taken from the httpOnly cookie, the same way the rest of the app already trusts the cookie. `get_dealers_reputation` and `get_dealer_reviews` only ever return visible rows, so they cannot leak a blind rating regardless of caller. `get_rating_state` returns the viewer's *own* blind rating, so a caller who forged another dealer's id could see that dealer's not-yet-revealed score; this is the same forge-any-dealer-id gap the current no-auth demo model has everywhere (see the notifications migration's "no-RLS demo trust model" note), and real authentication (a later slice) closes it for all of these at once. It is called out here, not solved here.

A thin service module `src/lib/ratings.ts` wraps these RPCs for the pages and components, mirroring the existing `src/lib/*` service pattern.

## UI surfaces

- **Rating panel.** A new `RateDealPanel` component on the auction detail page (`src/app/auction/[id]/page.tsx`), shown when the auction is `sold` and the viewer is the eligible seller or buyer. Its state comes from `get_rating_state`: *rate now* (star selector plus optional comment) transitions to *submitted, hidden until both rate or 14 days* and finally to *revealed* (both scores and comments shown). The `/won/[id]` page and the `'rate'` notification both link to the auction detail page, so there is a single home for the interaction.
- **Dealer profile** (`src/app/dealer/[id]/page.tsx`). The single static `★` line is replaced by two derived lines, `As seller ★4.8 (23)` and `As buyer ★4.6 (15)`, or `No ratings yet` when a side has no visible ratings, plus a reviews list of revealed comments from `get_dealer_reviews`.
- **`DealerBadge`** (`src/components/DealerBadge.tsx`, used on auction cards and the bid panel) gains the seller's seller-side score inline, or a subtle "New" when the seller has no visible ratings. The page fetches reputation for the distinct sellers it is about to render in one `get_dealers_reputation` call and passes each score into the badge, rather than joining `ratings` into the card query, which keeps the blind-safe read path intact and avoids an N+1.

## Edge cases

- Seller equals winner (degenerate self-win): not eligible, only one party.
- Passed-in / cancelled / withdrawn auctions: no settlement, `not_sold`.
- Only one party rates and 14 days pass: that single rating reveals and locks; non-retaliation still held because neither could see the other during the window.
- A dealer with zero visible ratings on a side: shows "No ratings yet" / "New", never a number.

## Testing

Mirrors the existing Vitest + Playwright pattern.

- **Unit (Vitest, service-role RPC client):** `submit_rating` happy path and each guard (`not_sold`, `not_party`, `window_closed`, `already_rated`); blindness (counterpart cannot see a rating before reveal; both scores visible after both submit; a lone rating visible after 14 days); split seller-side vs buyer-side aggregation correctness. A new test helper `test_set_settlement_age(p_auction_id uuid, p_seconds int)` backdates a settlement's `created_at` to exercise the window-elapsed reveal path, analogous to the existing `test_set_end_in_seconds`. `test_reset` is extended to truncate `ratings` so tests stay isolated.
- **E2e (Playwright):** a sold auction where both parties rate and the reputation then appears on the seller's profile; and the blind-until-reveal transition (a rating not visible to the counterpart until the second rating lands).

## Migration and cleanup

A single migration `supabase/migrations/0012_ratings.sql` contains: the `ratings` table, the `settlements.created_at` column, the `dealers.rating` drop, the `submit_rating` writer, the three `security definer` read functions, the redefined `close_auction` / `buy_now_listing` writers with the `'rate'` notification inserts, the `notifications.type` check-constraint change, the grants (service-role-only on `ratings`, execute grants on the read functions to `anon`/`authenticated`), the `test_set_settlement_age` helper and the `test_reset` extension. Application changes: the new `src/lib/ratings.ts`, the new `RateDealPanel` component, and edits to the auction detail page, the dealer profile page, `DealerBadge`, and `src/types/db.ts`. Seed data (`supabase/seed.sql`) gains a handful of pre-revealed ratings so demo profiles are not empty.

## Out of scope

- Disputing or removing a rating: this belongs with the separate dispute-management feature.
- Email / SMS / push delivery of the `'rate'` prompt: in-app only, consistent with every current notification.
- Weighting, decay, or minimum-deals-to-display thresholds on the averages: a plain mean over visible rows is enough for this slice.
