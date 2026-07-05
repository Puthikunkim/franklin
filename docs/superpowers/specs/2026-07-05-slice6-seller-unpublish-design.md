# Slice 6 — Seller live-auction control: Unpublish (revert to draft)

**Status:** Design approved 2026-07-05
**Predecessors:** Slices 1 (hero auction flow), 2 (listing creation), 3 (dealer dashboard), 4 (discovery), 5 (buy-now), all merged to `main`.

## 1. Goal

Give a seller a way to pull a live auction they own back off the market, as long as no
one has bid on it yet. "Unpublish" reverts the live auction to a `draft`, which the seller
can then edit and republish through the existing draft flow — so this single capability
delivers both "cancel a live auction" and "edit a live auction" without any new edit UI.
Until now a listing could only go draft → live (publish); there was no way back.

## 2. Scope

**In scope:**
- An `unpublish_listing` writer RPC that reverts a live, un-bid, owned auction to `draft`.
- An `unpublishListing` service + `unpublishAction` server action (cookie-sourced identity).
- An `UnpublishButton` on the dashboard "My listings" live rows (no-bid only).

**Out of scope (later slices):** cancelling/withdrawing a live auction that *has* bids,
in-place editing of a live auction (edit happens after revert, via the existing `/sell/[id]`
draft form), a terminal "cancelled" status, refunds/notifications to watchers, real
payments/auth/verification. No credential-dependent work — this slice needs no R2 or
external creds.

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| What "cancel" does | Revert the live auction to `draft` (clears `start_time`); the seller edits/relists via the existing draft flow. |
| When it's allowed | Only while the auction is `live` AND has **no bids** (`current_bid is null`) AND is owned by the acting dealer. You cannot pull a listing out from under active bidders. |
| Security | `SECURITY DEFINER`, `service_role`-only RPC via a `"use server"` action; seller identity from the httpOnly `dealer_id` cookie (Slice 2–5 writer pattern). |
| Placement | Dashboard "My listings" live rows — symmetric with the existing "Discard" on draft rows. |
| Edit/relist path | Reuse existing UI: a reverted draft's `/auction/[id]` shows `PublishPanel`, which already links "Edit draft" (→ `/sell/[id]`) and "Publish auction". No new edit UI. |

## 4. Data model

New migration `supabase/migrations/0008_unpublish.sql`.

**`unpublish_listing` (writer RPC):**
```
unpublish_listing(p_auction_id uuid, p_dealer_id uuid) returns text
language plpgsql security definer set search_path = public
```
Locks the auction `for update`, then guards in order and returns a status string:
- missing OR `seller_dealer_id <> p_dealer_id` → `'not_owner'`
- `status <> 'live'` → `'not_live'` (a draft/ended/sold/passed auction can't be unpublished)
- `current_bid is not null` → `'has_bids'` (can't unpublish once bidding has started)

Otherwise it reverts:
```
update auctions set status = 'draft', start_time = null where id = p_auction_id;
return 'reverted';
```
Reverting to `draft` removes it from the live grid (drafts are owner-private) and clears
`start_time` so a later republish sets a fresh one. No settlement, bids, or vehicle rows are
touched (an un-bid live auction has no bids anyway).

**Grants (Slice 2–5 writer pattern):** `revoke execute on function unpublish_listing(uuid, uuid) from public, anon, authenticated;` then `grant execute ... to service_role;`. The browser anon key must never reach it (regression-tested).

No schema/column change (`status`, `start_time` already exist). No seed change (the seeded
live auctions owned by dealer 1 — e.g. `a06` Toyota Hilux — are live with no bids after reset).

## 5. Service + action

- **Service** `unpublishListing(dealerId, auctionId): Promise<{ ok: boolean; reason?: string }>` — added to `src/lib/listings/service.ts` alongside `publishListing`/`discardDraft`. Service-role client → `unpublish_listing` RPC; `{ ok: true }` when the RPC returns `'reverted'`, else `{ ok: false, reason: <status> }`.
- **Action** `unpublishAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }>` (`"use server"`) — added to `src/app/dashboard/actions.ts` next to `discardDraftAction`. Reads the `dealer_id` cookie (redirect `/login` if absent), reads `auctionId` from the form, calls `unpublishListing`. On success, revalidate `/dashboard` (the row changes), `/` (it leaves the live grid), and `/auction/${auctionId}` (its detail page becomes the draft view); returns `{}`. On failure, return `{ error }` from a friendly message map. Seller identity is always the cookie dealer, never client input.

## 6. UI

- **`UnpublishButton`** (`"use client"`) — a two-step-confirm button modeled exactly on `DiscardDraftButton`: first render an "Unpublish" button; on click show "Unpublish this listing? It reverts to a draft you can edit and republish." with **Yes** / **No**; **Yes** submits `unpublishAction` (via `useActionState`) with a hidden `auctionId`. Shows the action's `{error}` inline on failure.
- **Dashboard "My listings"** (`src/app/dashboard/page.tsx`) — in each row, render `<UnpublishButton>` only when `a.status === 'live' && a.current_bid == null`, beside the status label (mirroring how `<DiscardDraftButton>` is rendered only when `a.status === 'draft'`). `getMyListings` already returns `current_bid` (it selects `*`), so no query change.
- No other surface changes: after a revert the row shows `draft` + the existing `DiscardDraftButton`, and `/auction/[id]`'s `PublishPanel` provides edit/republish.

## 7. Error handling

- The row is server-rendered from a snapshot; the RPC is the real guardrail. If a bid lands
  between render and click, the RPC returns `'has_bids'` and the button surfaces the message;
  the auction stays live.
- Message map: `not_owner` → "You can only unpublish your own listing."; `not_live` → "This
  listing isn't live."; `has_bids` → "This listing has bids and can't be unpublished.";
  `error` → "Could not unpublish, try again." The button surfaces the message and the row is
  unchanged.
- No dealer cookie → the action redirects to `/login` before touching the DB.
- The revert is owner-, live-, and no-bids-gated at the DB (the final guardrail), not just UI.

## 8. Testing

- **Integration (vitest vs local Supabase):** To avoid leaking mutated seed state into the
  shared DB (`test_reset` only resets non-draft rows, so a reverted seed auction would stay a
  draft), the mutation tests build their own fixture: `create_draft_listing` → `publish_listing`
  yields a live, un-bid auction owned by the test dealer, exercised then cleaned up. An
  `afterEach` deletes every auction the file created (and its vehicle/bids), restoring seed
  state; read-only guard cases may use seed rows since they don't mutate.
  - `unpublish_listing` happy path — a freshly published (live, un-bid) auction owned by the
    dealer becomes `status = 'draft'` with `start_time = null` and returns `'reverted'`.
  - Guards: `not_owner` (a created live auction unpublished by a *different* dealer, plus a
    nonexistent id → `'not_owner'`); `not_live` (the seeded `draft` auction → `'not_live'`,
    unchanged, read-only); `has_bids` (create+publish a live auction, `place_bid` on it, then
    unpublish → `'has_bids'`, still `live`).
  - Round-trip: after `unpublish_listing` reverts a created auction to draft, `publish_listing`
    (existing) publishes it back to `live` — confirming the revert leaves a valid draft.
  - Security: an anon-role `rpc('unpublish_listing', …)` call is denied (regression, mirrors
    Slices 2–5).
  - `unpublishListing` service test (reverts a created live auction; returns the reason for a
    non-owner).
- **e2e (Playwright):** log in as Auckland Motor Wholesale (dealer 1), open `/dashboard`,
  locate the live **Toyota Hilux** (`a06`, seller = dealer 1, no bids) row in "My listings",
  click **Unpublish** → **Yes**, and confirm that row now shows `draft` with a **Discard**
  button (and no **Unpublish**). Uses `a06` specifically because no other e2e spec touches it
  (`a01` is bid on by bidding.spec, `a02` by discovery/realtime, `a03` sold by buy-now), and
  buy-now/unpublish permanently change auction state while globalSetup resets the DB only
  once. No R2, so it runs.
- **Invariant:** the anon client cannot execute `unpublish_listing`; a live auction with bids
  can never be reverted to draft.

## 9. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via PR / merge
at completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred
until the app is code-complete — this slice adds none. The full vitest suite runs sequentially
(`fileParallelism: false`) because integration tests share one local Supabase DB; new
integration tests must reset/clean their own state and scope any global assertions to seeded
ids. e2e specs run with `workers: 1` and a *fresh* dev server per full run (a stale
long-lived dev server degrades the heavier realtime spec).
