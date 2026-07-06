# Slice 10 — Seller withdraws a live auction that has bids

**Status:** Design approved 2026-07-07
**Predecessors:** Slices 1–9 (hero flow, listing creation, dashboard, discovery, buy-now, unpublish, notifications, auto-close, dealer profiles) + a test-hygiene fix, all merged to `main`.

## 1. Goal

Give a seller a way to pull a live auction they own off the market **after bidding has
started**. Slice 6's unpublish only handles a *no-bid* live auction (it reverts to draft for
relisting). A bid-on auction can't just revert to draft — bidders are actively involved — so
withdrawing it moves it to a new **terminal `cancelled` status** and notifies the bidders. This
completes the seller live-auction controls: unpublish (no bids → draft) and withdraw (has bids
→ cancelled).

## 2. Scope

**In scope:**
- A new terminal `cancelled` auction status.
- A `withdraw_listing` writer RPC: a live, owned, **bid-on** auction → `cancelled`, notifying
  every distinct bidder.
- A `withdrawn` notification type (reusing Slice 7's generation), with a page label.
- A `withdrawListing` service + `withdrawAction` server action (cookie identity).
- A `WithdrawButton` on the dashboard "My listings" live rows **that have bids**.
- A minimal `cancelled` state on the auction detail page (banner + suppress the bid panel).

**Out of scope (later / rejected):** re-listing a cancelled vehicle as a fresh auction,
withdrawing an *ended* auction, refunds/fees (there are none), notifying watchers (only
bidders), any admin reversal, un-cancelling. No credential-dependent work — this slice needs
none.

## 3. Product decisions (locked; made conservatively per the user's delegation)

| Decision | Choice |
|----------|--------|
| Outcome | A new **terminal `cancelled` status**, NOT revert-to-draft. Withdrawing a bid-on auction is deliberate and non-reversible — you can't silently pull it back and relist as if the bids never happened. |
| When allowed | Seller, own auction, `status='live'` AND **has bids** (`current_bid is not null`). No bids → the RPC returns `no_bids` (use the existing unpublish/revert-to-draft path). |
| Bidders | Every **distinct** dealer who bid gets one `withdrawn` notification. Reuses Slice 7's `_notify`. |
| Money | None. Withdrawal is not a sale — no settlement row, no fees, no winner. |
| Reversibility | Terminal. `cancelled` is a dead end. |
| Naming | Action/RPC verb "withdraw"; resulting status `cancelled`; success token `'withdrawn'` (distinct from the status, following the Slice 5 `bought`≠`sold` / Slice 6 `reverted` convention); notification type `withdrawn`. |
| Security | `SECURITY DEFINER`, service_role-only via revoke-before-grant; seller identity from the httpOnly `dealer_id` cookie (Slices 2–9 writer pattern). |
| Placement | Dashboard "My listings" live rows with bids — symmetric with unpublish on the no-bid live rows. |

## 4. Data model

New migration `supabase/migrations/0011_withdraw.sql`.

**Enum + constraint (safe in one migration — plpgsql bodies are late-bound, mirroring how 0004
added `draft` and used it in the same file):**
```sql
alter type auction_status add value if not exists 'cancelled';

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('outbid','won','sold','withdrawn'));
```

**`withdraw_listing` (writer RPC):**
```sql
create or replace function withdraw_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype; r record;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'live' then return 'not_live'; end if;
  if a.current_bid is null then return 'no_bids'; end if;   -- no bids → use unpublish (revert to draft)
  update auctions set status = 'cancelled' where id = p_auction_id;
  for r in select distinct bidder_dealer_id from bids where auction_id = p_auction_id loop
    perform _notify(r.bidder_dealer_id, 'withdrawn', p_auction_id);
  end loop;
  return 'withdrawn';
end; $$;

revoke execute on function withdraw_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function withdraw_listing(uuid, uuid) to service_role;
```
The `for update` lock serializes against `place_bid` (a bid landing between render and click is
caught: it's already counted, and withdraw still cancels correctly). `cancelled` is only ever
*used* inside the function body (deferred to runtime), so adding the enum value and defining the
function in one migration is safe. No settlement, no bid rows touched. `_notify` is unchanged.

## 5. Service + action

- **Service** `withdrawListing(dealerId, auctionId): Promise<{ ok: boolean; reason?: string }>`
  in `src/lib/listings/service.ts` alongside `unpublishListing`: service-role client →
  `withdraw_listing` RPC; `{ ok: true }` when it returns `'withdrawn'`, else
  `{ ok: false, reason: <status> }`.
- **Action** `withdrawAction(_prev, formData)` (`"use server"`) in `src/app/dashboard/actions.ts`
  next to `unpublishAction`: reads the `dealer_id` cookie (redirect `/login` if absent) and
  `auctionId` from the form, calls `withdrawListing`. On success revalidate `/dashboard`, `/`,
  and `/auction/${auctionId}`; on failure return `{ error }` from a message map
  (`not_owner` → "You can only withdraw your own listing."; `not_live` → "This listing isn't
  live."; `no_bids` → "This listing has no bids — unpublish it instead."; `error` → "Could not
  withdraw, try again.").

## 6. UI

- **`WithdrawButton`** (`"use client"`) — a two-step-confirm button modeled on `UnpublishButton`
  but **red/destructive**: first an "Withdraw" button; on click, "Withdraw and cancel this
  auction? Bidders will be notified and this can't be undone." with **Yes** / **No**; **Yes**
  submits `withdrawAction` (`useActionState`) with a hidden `auctionId`. Surfaces the action's
  `{error}` inline. Imports only `@/app/dashboard/actions`.
- **Dashboard "My listings"** (`src/app/dashboard/page.tsx`) — render `<WithdrawButton>` only
  when `a.status === 'live' && a.current_bid != null`, beside the status label. This complements
  the existing `a.status === 'live' && a.current_bid == null` → `<UnpublishButton>`.
  `getMyListings` already selects `*`, so no query change.
- **Auction detail page** (`src/app/auction/[id]/page.tsx`) — add `const isCancelled =
  auction.status === 'cancelled'`. When cancelled, render a banner ("This auction was withdrawn
  by the seller.") and render **no** right-hand action panel (guard the existing `BidPanel` on
  `!isDraft && !isCancelled`; `canBuyNow` already requires `status === 'live'`). The
  withdrawn-bidder's notification links here, so it must not look like a live, biddable auction.

## 7. Error handling

- The dashboard row is a snapshot; the RPC is the guardrail. If the state changed (already
  cancelled, or a bid arriving) the RPC returns the appropriate token and the button surfaces
  the message; the auction is unchanged except by the acting call.
- No dealer cookie → the action redirects to `/login` before any DB write.
- Withdrawal is owner-, live-, and has-bids-gated at the DB (the final guardrail), not just UI.
- `cancelled` auctions automatically leave every live/active surface: `search_live_auctions`
  (`status='live'`), `getMyBiddingAuctions` (`status='live'`), `getDealerLiveListings`
  (`status='live'`); they never enter `getMySales`/`getDealerSales` (`status='sold'`) or
  `getMyWins`. They remain visible to the **seller** in dashboard "My listings" (which shows all
  statuses) labelled `cancelled`, with no action button.

## 8. Testing

- **Integration (vitest vs local Supabase):** own-fixture hygiene (`createLiveAuction` + bids +
  `deleteAuctions`, which already deletes notifications; `beforeEach(resetDb)`).
  - Happy path: a live auction with two distinct bidders, withdrawn by the owner → `status =
    'cancelled'`, returns `'withdrawn'`, and **each distinct bidder** has exactly one `withdrawn`
    notification (a dealer who bid twice gets one, not two).
  - Guards: `not_owner` (different dealer, and a nonexistent id); `not_live` (a created draft, or
    an already-cancelled auction); `no_bids` (a live auction with no bids → `'no_bids'`,
    unchanged).
  - Security: an anon-role `withdraw_listing` call is denied (regression, mirrors Slices 2–9).
  - Surfaces: a cancelled auction is absent from `search_live_auctions` results and from
    `getMyBiddingAuctions` for a dealer who bid on it.
  - Service: `withdrawListing` reverts a created bid-on auction (returns `{ ok: true }`) and
    returns the reason for a non-owner.
- **e2e (Playwright):** two-dealer flow on the **spare** a07 (Ford Ranger, seller = Waikato Trade
  Cars / D2 — no other spec needs it live). Dealer A (Auckland / D1) bids on a07; re-login as D2,
  open `/dashboard`, locate the Ford Ranger row, **Withdraw** → **Yes**, and confirm the row now
  shows `cancelled` and the Withdraw button is gone. a07 → cancelled permanently, but no other
  spec depends on it. `listing.spec` stays skipped (R2). `workers: 1`, fresh dev server.
- **Invariant:** the anon client cannot execute `withdraw_listing`; a `cancelled` auction never
  reappears as live/biddable and is never a sale; every distinct bidder is notified exactly once.

## 9. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via merge at
completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred until
the app is code-complete — this slice adds none. The full vitest suite runs sequentially
(`fileParallelism: false`) because integration tests share one local Supabase DB; new
integration tests reset/clean their own state and scope global assertions to seeded ids. e2e
specs run with `workers: 1` and a *fresh* dev server per full run.
