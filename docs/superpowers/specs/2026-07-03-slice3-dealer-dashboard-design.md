# Slice 3 — Dealer Dashboard ("My Activity")

**Status:** Design approved 2026-07-03
**Predecessors:** Slice 1 (hero auction flow) and Slice 2 (listing creation), both merged to `main`.

## 1. Goal

Give a logged-in dealer a single "my activity" home that ties together everything the
platform already does: the listings they've created (including drafts), the auctions
they're bidding on, the auctions they've won (to settle), and their completed sales. It is
primarily a review-and-navigate surface that links out to the existing pages which own each
action, plus one new capability: discarding a draft.

## 2. Scope

**In scope:**
- A `/dashboard` page with four sections: My listings, Auctions I'm bidding on, My wins, My sales.
- Four read queries over existing tables, scoped to the current dealer.
- Discarding a draft listing (a new owner-gated, drafts-only delete).
- A "Dashboard" nav link in the header.

**Out of scope (later slices):** search/filter/sort of the public grid, watchlist,
notifications, analytics/charts, cancelling a *live* auction, editing a live auction, real
payments, real dealer verification, native mobile app. The dashboard reads and links out;
the only write it introduces is draft discard.

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Sections | My listings, Auctions I'm bidding on, My wins (to settle), My sales |
| Draft discard | Yes — a new `service_role`-only `SECURITY DEFINER` RPC |
| Freshness | Snapshot at page load; no realtime on the dashboard |
| Data fetch | A TypeScript read-query module (`src/lib/dashboard.ts`), mirroring `src/lib/auctions.ts` |

## 4. Route, layout & data flow

- **`/dashboard`** — an async server component. Redirects to `/login` when there is no
  `dealer_id` cookie. Reads the dealer id server-side and renders the four sections stacked
  on one scannable page; each section shows a heading, a count, and an empty-state message
  when it has no rows.
- **Snapshot semantics:** all data is fetched server-side at load. No realtime subscription
  on this page. Each row links out to the page that owns its live behavior:
  - a listing/bidding/win row → the auction detail page `/auction/[id]` (which has the
    realtime bid panel, or the owner draft preview),
  - a draft → `/sell/[id]` (edit) and `/auction/[id]` (preview/publish),
  - a win → `/won/[id]` (settlement).
- The `Header` component (from Slice 2) gains a "Dashboard" link, shown when logged in
  alongside "Sell a vehicle".

## 5. Read queries (`src/lib/dashboard.ts`)

Each function takes the dealer id and returns typed rows using the read-only anon server
client, following `getLiveAuctions`'s FK-disambiguated join style
(`seller:dealers!auctions_seller_dealer_id_fkey(*)`, `vehicle:vehicles(*)`). All money stays
integer cents; the UI formats with `formatNZD`.

- **`getMyListings(dealerId)`** — `auctions` where `seller_dealer_id = dealerId`, ALL
  statuses (draft/live/ended/sold/passed), newest first, with `vehicle`. The UI groups/labels
  rows by status (Draft / Live / Ended-or-done).
- **`getMyBiddingAuctions(dealerId)`** — auctions with `status = 'live'` that the dealer has
  bid on. Implemented as two steps: select distinct `auction_id` from `bids` where
  `bidder_dealer_id = dealerId`, then fetch those auctions (`.in('id', ids).eq('status','live')`)
  with `vehicle`. Each row derives **Winning** vs **Outbid** from
  `current_winner_dealer_id === dealerId`, and shows `current_bid`.
- **`getMyWins(dealerId)`** — auctions where `current_winner_dealer_id = dealerId` and the
  auction has ended (`status in ('ended','sold')` OR `end_time <= now()`), with `vehicle`.
  Each links to `/won/[id]`.
- **`getMySales(dealerId)`** — auctions where `seller_dealer_id = dealerId` and
  `status in ('sold','passed')`, with `vehicle` and the joined `settlement`
  (`settlement:settlements(*)`) — sale price when sold, "passed in" when passed.

Reads need no new grants (anon already has SELECT on all these tables from Slice 1).

## 6. Discard draft (the one new write)

New migration `supabase/migrations/0005_discard_draft.sql`.

- **`discard_draft_listing(p_auction_id uuid, p_dealer_id uuid) RETURNS text`** —
  `language plpgsql security definer set search_path = public`. Takes a `for update` lock on
  the auction; returns `'not_owner'` if missing or `seller_dealer_id <> p_dealer_id`;
  `'not_draft'` if `status <> 'draft'`; otherwise deletes the auction, then its vehicle, and
  returns `'discarded'`.
- **Grants (Slice 2 security pattern):** `revoke execute ... from public, anon, authenticated;`
  then `grant execute ... to service_role;` — the browser anon key must never reach it.
- **Service layer** (`src/lib/listings/service.ts`): add
  `discardDraft(dealerId, auctionId): Promise<{ ok: boolean; reason?: string }>` calling the
  RPC via the service-role client.
- **Server action** (`src/app/sell/actions.ts` or a dashboard actions file):
  `discardDraftAction` reads the `dealer_id` cookie (redirect `/login` if absent), calls
  `discardDraft`, then `revalidatePath('/dashboard')` and returns `{ error }` on failure.
- **UI:** a `DiscardDraftButton` (client) with a confirm step ("Discard this draft?") before
  firing, shown only on draft rows in My listings.

Deleting the vehicle is safe: a draft's vehicle is created solely for that draft (Slice 2
creates them together) and nothing else references it. Only the auction's `vehicle_id` points
to it, and the auction is deleted first.

## 7. Components

- **`DashboardSection`** — presentational wrapper: heading + count + children, with an
  empty-state message prop.
- **Per-section row components** — compact rows reusing `formatNZD`, `DealerBadge`, and
  `CountdownTimer` where useful (e.g. time left on a live auction the dealer is bidding on).
  A bidding row shows a Winning/Outbid pill; a sales row shows the sale price or "passed in".
- **`DiscardDraftButton`** — client component: confirm, then submit the discard action.
- **`Header`** — add the "Dashboard" link.

## 8. Error handling

- No dealer cookie → `redirect('/login')` before any query.
- Read queries that error return empty arrays (a section renders its empty state rather than
  crashing the page).
- `discard_draft_listing` rejections map to friendly messages (`not_owner` → "You can only
  discard your own draft.", `not_draft` → "This listing is already published."). The button
  surfaces the message and the row stays.
- Discard is owner- and draft-gated at the DB (the final guardrail), not just in the UI.

## 9. Testing

- **Integration (vitest vs local Supabase):**
  - the four query functions against seeded data — correct dealer scoping, status filters,
    Winning/Outbid derivation, and sales joined to settlements;
  - `discard_draft_listing` — happy path (deletes auction + vehicle, returns `'discarded'`),
    non-owner → `'not_owner'`, non-draft (a live auction) → `'not_draft'`, and an anon-role
    denied regression test (mirrors Slice 2).
- **e2e (Playwright):** log in as the dealer who owns the seeded draft → open `/dashboard` →
  assert My listings shows that dealer's auctions including the seeded **Draft** → discard the
  draft → confirm it disappears from the section. This flow needs no R2 (discard doesn't
  upload, and the draft is seeded, not created through the photo-gated form), so — unlike the
  Slice 2 create e2e — it RUNS rather than skips. Creating a draft via `/sell` still needs R2
  and is already covered (and skipped) by the Slice 2 e2e; this test does not repeat it.
- **Invariant:** the anon client cannot execute `discard_draft_listing` (asserted).

**Seed change:** `supabase/seed.sql` gains exactly one **draft** listing (a vehicle + a
`status='draft'` auction with `start_time = null`) owned by a known seed dealer, so the
dashboard has a draft to display and the discard e2e has a deterministic target. Integration
tests that need other states (bids, wins, sales) construct them via the existing RPCs
(`place_bid`, `close_auction`) and `admin` writes — they do not rely on seeded runtime state.

## 10. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via PR / merge
at completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred
until the app is code-complete — this slice adds none.
