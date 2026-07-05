# Slice 5 — Buy Now (instant purchase)

**Status:** Design approved 2026-07-05
**Predecessors:** Slices 1 (hero auction flow), 2 (listing creation), 3 (dealer dashboard), 4 (discovery), all merged to `main`.

## 1. Goal

Let a dealer buy a live vehicle outright at its `buy_now_price` instead of bidding —
ending the auction immediately as a sale. `buy_now_price` is already stored on every
auction and shown on cards and the detail page, but it currently does nothing. This slice
makes it a real purchase path that mirrors the existing settlement flow.

## 2. Scope

**In scope:**
- A `buy_now_listing` writer RPC that closes a live, un-bid auction as a sale to the buyer.
- A `buyNow` service + `buyNowAction` server action (cookie-sourced buyer identity).
- A `BuyNowButton` (two-step confirm) on the auction detail page, shown only when eligible.
- Reuse of the existing `/won/[id]` page to confirm the purchase (sold view + settlement).

**Out of scope (later slices):** real payments/escrow (the settlement row is still a record,
not a charge), real dealer accounts/auth, buy-now *after* bidding has started, buy-now from
the grid/cards (the button lives on the detail page only), notifications, offer/counter-offer.
No credential-dependent work — this slice needs no R2 or external creds.

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Availability | Buy-now is available only **before the first bid** (`current_bid is null`); the first bid removes it. No buy-now-vs-bid race. |
| Who can buy | Any logged-in dealer **except the seller** of that auction. |
| Security | `SECURITY DEFINER`, `service_role`-only RPC via a `"use server"` action; buyer identity from the httpOnly `dealer_id` cookie (NOT the anon-callable `place_bid` style). |
| Price & fees | Sale price = `buy_now_price`; the settlement's default `seller_fee` ($200) and `buyer_fee` ($20) apply, exactly like an auction sale. |
| After purchase | Redirect the buyer to the existing `/won/[id]` page (sold + settlement view). |
| Button placement | Auction detail page only, above the bid panel; cards stay display-only. |

## 4. Data model

New migration `supabase/migrations/0007_buy_now.sql`.

**`buy_now_listing` (writer RPC):**
```
buy_now_listing(p_auction_id uuid, p_buyer_dealer_id uuid) returns text
language plpgsql security definer set search_path = public
```
Locks the auction `for update`, then guards in order and returns a status string:
- not found → `'not_found'`
- `status <> 'live'` → returns the current `status` (e.g. `'sold'`, `'draft'`, `'ended'`, `'passed'`) — not buyable
- `buy_now_price is null` → `'no_buy_now'`
- `current_bid is not null` → `'has_bids'` (the "before first bid" rule)
- `seller_dealer_id = p_buyer_dealer_id` → `'is_seller'`

Otherwise it completes the sale:
```
update auctions
   set status = 'sold',
       current_bid = buy_now_price,
       current_winner_dealer_id = p_buyer_dealer_id,
       end_time = now()              -- genuinely ended, so My wins / My sales pick it up
 where id = p_auction_id;
insert into settlements (auction_id, sale_price)
   values (p_auction_id, <buy_now_price>)
   on conflict (auction_id) do nothing;   -- mirrors close_auction
return 'sold';
```
`end_time = now()` matters: `getMyWins` filters `end_time <= now()`, so without it a buy-now
win (bought before the timer expired) would never appear on the dashboard. Because publish
enforces `buy_now_price > reserve_price`, the sale price is always `>= reserve`, so the
"reserve met" derivation used by `getMyWins` holds.

**Grants (Slice 2–4 writer pattern):** `revoke execute on function buy_now_listing(uuid, uuid) from public, anon, authenticated;` then `grant execute ... to service_role;`. The browser anon key must never reach it (regression-tested).

No schema/columns change (`buy_now_price`, `current_bid`, `current_winner_dealer_id`,
`status`, `settlements` all already exist). No seed change (seeded live auctions already have
`buy_now_price` and no bids after reset).

## 5. Service + action (`src/lib/purchase/`)

- **Service** `buyNow(dealerId, auctionId): Promise<{ ok: boolean; reason?: string }>` — service-role client → `buy_now_listing` RPC; returns `{ ok: true }` when the RPC returns `'sold'`, else `{ ok: false, reason: <status> }`. Mirrors `discardDraft`/`publishListing` in `src/lib/listings/service.ts`.
- **Action** `buyNowAction(_prev, formData)` (`"use server"`) — reads the `dealer_id` cookie (redirect `/login` if absent), reads `auctionId` from the form, calls `buyNow`. On success, revalidate every surface the sale changes — `revalidatePath('/')` (the live grid), `revalidatePath('/dashboard')` (buyer's "My wins" + seller's "My sales"), `revalidatePath('/auction/${auctionId}')` (the detail page) — then `redirect('/won/${auctionId}')`. On failure, returns `{ error }` from a friendly message map. The buyer is always the cookie dealer, never client input.

## 6. UI

- **`BuyNowButton`** (`"use client"`) — two-step confirm (like `DiscardDraftButton`): first render a "Buy now for <NZD>" button; on click, show "Buy now for <NZD>? You'll pay a $20 buyer fee." with **Confirm** / **Cancel**. Confirm submits `buyNowAction` (via `useActionState`) with a hidden `auctionId`. Shows the action's `{error}` inline on failure.
- **Auction detail page** (`src/app/auction/[id]/page.tsx`) — render `BuyNowButton` in the right column **above** the existing bid panel, only when **all** hold: `status === 'live'`, `buy_now_price != null`, `current_bid == null` (no bids yet), and `seller_dealer_id !== currentDealerId` (viewer isn't the seller). Drafts (which show the publish panel) never show it.
- Cards and the grid are unchanged (they already display `buy_now_price` as a stat; the action lives only on the detail page).

## 7. Error handling

- The server render decides eligibility from a snapshot; the RPC is the real guardrail. If a
  bid lands between render and click, the RPC returns `'has_bids'` and the button surfaces
  "Bidding has started — buy now is no longer available."
- Message map: `has_bids` → "Bidding has started — buy now is no longer available.";
  `is_seller` → "You can't buy your own listing."; `no_buy_now` → "This listing has no buy-now
  price."; any terminal status (`sold`/`ended`/`passed`) → "This auction is no longer
  available."; `not_found`/`error` → "Could not complete the purchase, try again." The button
  surfaces the message and the auction is unchanged.
- No dealer cookie → the action redirects to `/login` before touching the DB.
- The purchase is fully gated at the DB (live + un-bid + buyer≠seller), not just in the UI.

## 8. Testing

- **Integration (vitest vs local Supabase):**
  - `buy_now_listing` happy path — a live, un-bid auction bought by a non-seller becomes
    `sold`, `current_winner_dealer_id` = buyer, `current_bid` = `buy_now_price`, `end_time`
    now-ish, and a settlement exists with `sale_price = buy_now_price` and the default
    `seller_fee`/`buyer_fee`.
  - Guards: `has_bids` (place a bid via `place_bid`, then buy → `'has_bids'`, unchanged);
    `is_seller` (seller buys own → `'is_seller'`); already-sold (buy twice → second returns
    `'sold'` and does not double-insert a settlement); `no_buy_now` (an auction with
    `buy_now_price = null` → `'no_buy_now'`).
  - Dashboard integration: after a buy-now, the auction appears in the buyer's `getMyWins`
    and the seller's `getMySales`.
  - Security: an anon-role `rpc('buy_now_listing', …)` call is denied (regression, mirrors
    Slices 2–4).
- **e2e (Playwright):** log in as Auckland Motor Wholesale (dealer 1), open the Mazda CX-5
  auction (`a02`, seller = dealer 2, has a buy-now price, no bids), click **Buy now** →
  confirm → land on `/won/[id]` and see the vehicle sold with its sale price and the buyer
  fee. This needs no R2, so it runs. (Uses a seeded auction owned by a *different* dealer so
  the buyer-≠-seller rule is satisfied.)
- **Invariant:** the anon client cannot execute `buy_now_listing`; a bought auction is never
  resold (the `status <> 'live'` guard + settlement `on conflict do nothing`).

## 9. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via PR / merge
at completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred
until the app is code-complete — this slice adds none. The full vitest suite runs sequentially
(`fileParallelism: false`) because integration tests share one local Supabase DB; new
integration tests must tolerate that shared-DB model (reset/clean their own state, and scope
any global assertions to seeded ids as the discovery tests do). e2e specs run with
`workers: 1` for the same shared-DB reason, and a *fresh* dev server per full run (a stale
long-lived dev server degrades the heavier realtime spec).
