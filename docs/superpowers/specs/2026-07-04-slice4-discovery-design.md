# Slice 4 — Discovery (search, filter, sort + watchlist)

**Status:** Design approved 2026-07-04
**Predecessors:** Slices 1 (hero auction flow), 2 (listing creation), 3 (dealer dashboard), all merged to `main`.

## 1. Goal

Make the live auctions grid navigable and let dealers follow auctions they care about.
A dealer can search by vehicle, narrow by grade / price / region, sort the results, and
watch/unwatch any auction — with a "Watching" section on their dashboard.

## 2. Scope

**In scope:**
- Search/filter/sort controls on the home auctions grid (`/`), driven by URL search params.
- A `search_live_auctions` SQL function that applies the filters/sort server-side.
- A `watchlist` table + watch/unwatch toggle on auction cards and the auction detail page.
- A "Watching" section on the dashboard.

**Out of scope (later slices):** real dealer accounts/auth, real payments, dealer verification,
buy-now purchase flow, saved searches / alerts, pagination (the seed set is small; add later
if needed). No credential-dependent work — this slice needs no R2 or external creds.

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Controls | Text search (make/model/variant), grade filter, price range, region filter, sort |
| Filtering | Server-side via a SQL `search_live_auctions` function + URL search params |
| Watchlist view | A "Watching" section on the Slice 3 dashboard |
| Watch toggle | On auction cards and the auction detail page |
| Watch write path | `SECURITY DEFINER` `set_watch` RPC (`service_role` only) via a `"use server"` action |

## 4. Data model

New migration `supabase/migrations/0006_discovery.sql`.

**`search_live_auctions` (read function):**
```
search_live_auctions(
  p_q text, p_grades vehicle_grade[], p_min_price int, p_max_price int,
  p_region text, p_sort text
) returns setof auctions
language sql stable security invoker
```
Returns only `status = 'live'` auctions. Each parameter is optional (null / empty = no filter):
- `p_q`: case-insensitive match on the joined vehicle's make/model/variant (`ilike '%q%'`).
- `p_grades`: vehicle grade in the array (`= any(p_grades)`).
- `p_min_price` / `p_max_price`: range on the current price `coalesce(current_bid, starting_price)` (cents).
- `p_region`: exact match on the seller dealer's `region`.
- `p_sort`: `'ending_soon'` (default — `end_time asc`), `'price_asc'`, `'price_desc'` (by current price), `'newest'` (`start_time desc nulls last`).
Granted EXECUTE to `anon, authenticated` (it is a read; the underlying tables are already anon-SELECTable). Returning `setof auctions` means callers re-join vehicle + seller with the existing pattern.

**`watchlist` table:**
```
watchlist (
  dealer_id  uuid not null references dealers(id),
  auction_id uuid not null references auctions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (dealer_id, auction_id)
)
```
`on delete cascade` on `auction_id` so discarding/deleting an auction cleans up its watches.
Granted SELECT to `anon, authenticated` (reads for watch state); INSERT/DELETE only via the RPC (revoke write from public/anon/authenticated is implicit — no write grant is given to them).

**`set_watch` (write RPC):**
```
set_watch(p_dealer_id uuid, p_auction_id uuid, p_watched boolean) returns boolean
language plpgsql security definer set search_path = public
```
When `p_watched`: `insert into watchlist(dealer_id, auction_id) values (...) on conflict do nothing`.
Else: `delete from watchlist where dealer_id = p_dealer_id and auction_id = p_auction_id`.
Returns the resulting watched state (`p_watched`). Grants: `revoke execute ... from public, anon, authenticated; grant execute ... to service_role;` (Slice 2/3 pattern).

## 5. Reads (`src/lib/discovery.ts`, DI client like Slice 3)

All take `(sb: SupabaseClient, ...)` so they are testable with the `admin` client; the page/dashboard pass `await serverClient()`.
- **`type AuctionFilters = { q?: string; grades?: string[]; minPrice?: number; maxPrice?: number; region?: string; sort?: string }`**
- **`searchLiveAuctions(sb, filters)`** — calls the `search_live_auctions` RPC with the mapped params, collects the returned auction ids **in the RPC's order**, then fetches those auctions with the standard `vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)` join via `.in("id", ids)`. Because `.in(...)` does NOT preserve order, the joined rows are then **re-sorted in TS to match the ordered id list** (build a `Map<id, row>` and map over the ordered ids). Returns `[]` on empty. Replaces `getLiveAuctions` on the home grid.
- **`getWatchedAuctionIds(sb, dealerId)`** — returns a `string[]` of auction ids the dealer watches (for rendering watch icons).
- **`getMyWatching(sb, dealerId)`** — the dealer's watched auctions joined to `vehicle`, for the dashboard "Watching" section.

## 6. Write path (`src/lib/watch/` + a server action)

- **Service** `setWatch(dealerId, auctionId, watched): Promise<{ ok: boolean; watched?: boolean }>` — service-role client → `set_watch` RPC (mirrors `discardDraft`).
- **Action** `toggleWatchAction(formData)` (`"use server"`) — reads the `dealer_id` cookie (redirect `/login` if absent), reads `auctionId` + `watched` from the form, calls `setWatch`, `revalidatePath` on the affected surfaces (`/` and `/dashboard`). The seller identity is the cookie dealer, never client input.

## 7. UI

- **Home grid `/`** — a **`FilterBar`** client component above the grid: search box, grade multiselect, min/max price inputs, region `<select>`, sort `<select>`, and a "Clear" reset. Changing a control updates the URL search params (`?q=&grade=A,B&min=&max=&region=&sort=`); the page is an async server component that parses `searchParams`, builds `AuctionFilters`, and calls `searchLiveAuctions`. Empty state: "No auctions match your filters." Region options come from the distinct seeded dealer regions (a small static list is acceptable).
- **`WatchButton`** (client) — a heart toggle on `AuctionCard` and the auction detail page; submits `toggleWatchAction` with `auctionId` + the target `watched` state; filled when watched. Only rendered when logged in.
- **`AuctionCard`** — gains the `WatchButton` (top corner) and receives a `watched` boolean prop; the grid passes `getWatchedAuctionIds` membership.
- **Auction detail page** — gains the `WatchButton` near the title (for live auctions; not on drafts).
- **Dashboard** — a fifth `DashboardSection` "Watching", rows linking to each watched auction (reuses the Slice 3 row pattern).

## 8. Error handling

- Invalid/garbage search params are ignored (treated as "no filter"); the grid never 500s on a bad query string. Price params that aren't finite positive integers are dropped.
- `searchLiveAuctions` / watch reads return `[]` on query error (empty grid/section, consistent with the existing `getLiveAuctions` pattern).
- `toggleWatchAction` redirects to `/login` without a cookie; the RPC write is `service_role`-only and cookie-scoped.
- Watch state is per-dealer; a logged-out viewer sees no watch buttons.

## 9. Testing

- **Integration (vitest vs local Supabase):**
  - `search_live_auctions` — each filter narrows correctly (text matches make/model/variant; grade; price range on current price; region), each sort orders correctly, and `draft`/`ended`/`sold`/`passed` auctions are excluded (live only).
  - `set_watch` — watch inserts, unwatch deletes, double-watch is idempotent (on conflict), returns the watched state; an anon-role call is denied (regression, mirrors Slices 2–3).
  - `getWatchedAuctionIds` / `getMyWatching` — dealer scoping (one dealer's watches don't appear for another).
- **e2e (Playwright):** on `/`, type a search that matches one seeded vehicle and confirm the grid narrows to it; clear; watch an auction from its card; open `/dashboard` and see it under "Watching"; unwatch and confirm it leaves the section. No R2 — this runs.
- **Invariant:** the anon client cannot execute `set_watch`; `search_live_auctions` never returns a non-live auction.

## 10. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via PR / merge
at completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred
until the app is code-complete — this slice adds none. The full vitest suite runs sequentially
(`fileParallelism: false`, established in Slice 3) because integration tests share one local
Supabase DB; new integration tests must tolerate that shared-DB model (reset/clean their own state).
