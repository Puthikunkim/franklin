# Slice 2 — Listing Creation (draft → preview → publish)

**Status:** Design approved 2026-06-25
**Predecessor:** Slice 1 (hero auction flow) — merged to `main` at `f9582ed`.

## 1. Goal

Let a logged-in dealer create their own auction instead of relying on seeded data. A
dealer fills a form (vehicle details + auction terms), saves it as a **draft**, previews
it as it will appear, and then **publishes** it so it goes live in the auctions grid.

This removes the seed-only limitation called out in the Slice 1 spec ("substitutes for
listing-creation until Slice 2").

## 2. Scope

**In scope:**
- A create/edit form for a vehicle + auction terms.
- Draft persistence (a listing is not public until published).
- A preview of the draft rendered as the live detail page will look, gated to the owner.
- A publish action that validates and flips the draft live.
- Real photo upload to Cloudflare R2 via presigned URLs.

**Out of scope (later slices):** a "my listings" dashboard, editing/cancelling a *live*
auction, search/filter, ratings/verification, real payments, real dealer verification,
AI pricing, native mobile app. Drafts can be edited and published; there is no separate
draft-management dashboard in this slice.

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Lifecycle | create → **draft** → preview → **publish** (goes live) |
| Photos | **Real upload to Cloudflare R2** via presigned PUT URLs |
| Auction timing | Dealer picks an **explicit end date/time** (validated future, ≤ 30 days out) |
| Write path | **Server Actions** (cookie identity) + **`SECURITY DEFINER` RPCs** (service_role only) |

## 4. Data model & lifecycle

New migration `supabase/migrations/0004_listings.sql`.

**Status enum:** `alter type auction_status add value 'draft';`
Lifecycle: `draft` → `live` → `ended` → (`sold` | `passed`).

Drafts are **excluded from the public grid (`getLiveAuctions`) and the realtime feed**;
only the owning dealer can read or preview their own draft.

**`auctions` table changes:**
- `start_time` becomes **nullable** — a draft has no start until publish. On publish,
  `start_time = now()`.
- `end_time` is the dealer's explicit chosen datetime, stored at draft time and
  **re-validated as still-future at publish**.

**Vehicles:** created by the dealer using the existing `vehicles` table. The new auction
references the new vehicle, with `seller_dealer_id = <cookie dealer>`. Ownership of a draft
is determined by `auctions.seller_dealer_id` — no new column needed.

**Fields the dealer sets:**
- *Vehicle:* make, model, year, variant, odometer, grade (A–E), color, mechanical notes,
  appraisal notes, photos (`photo_urls text[]`).
- *Auction terms:* starting price, reserve price, buy-now price (optional), explicit end
  date/time.
- *Defaults not exposed in the form:* `bid_increment` (25000), `anti_snipe_seconds` (30).

## 5. Write path, RPCs & validation

**Trust boundary = server.** Create-draft / update-draft / publish run as server actions.
The seller identity is read from the httpOnly `dealer_id` cookie **server-side** and is
never accepted from the client.

**Three `SECURITY DEFINER` functions, `set search_path = public`, EXECUTE granted to
`service_role` ONLY (never `anon`):**
- `create_draft_listing(...)` — inserts vehicle + a `draft` auction atomically; returns the
  new auction id.
- `update_draft_listing(p_auction_id, p_dealer_id, ...)` — updates vehicle + auction **only
  if** `seller_dealer_id = p_dealer_id` AND `status = 'draft'`; otherwise rejects.
- `publish_listing(p_auction_id, p_dealer_id)` — guards ownership + `status='draft'`,
  re-validates (`end_time > now()`, required fields present, ≥ 1 photo), then sets
  `status='live'`, `start_time=now()`. Returns the new status or a structured rejection
  reason (e.g. `not_owner`, `not_draft`, `end_in_past`, `no_photos`).

**Validation** lives in a shared TypeScript module used by the form and server actions for
good UX, and is **mirrored in the publish RPC** for an atomic DB-side guardrail:
- make / model / year required; year in a sane range (1980 … next calendar year).
- odometer ≥ 0; grade ∈ {A,B,C,D,E}.
- starting_price > 0; reserve_price ≥ starting_price; buy_now (if set) > reserve_price.
- end_time in the future and ≤ 30 days out.
- between 1 and 12 photos.

**Invariants preserved from Slice 1:**
- `place_bid` remains the only writer of `bids`.
- The anon client stays read-only — the new RPCs are not granted to `anon`, so the browser
  cannot reach them.
- The service-role key stays strictly server-side (never `NEXT_PUBLIC`).

## 6. UI screens & flow

- **`/sell`** — create form (server component shell + client form): vehicle fields, auction
  terms, explicit end date/time picker, photo uploader. "Save draft" → `create_draft_listing`
  via server action → redirect to the preview.
- **`/sell/[id]`** — edit an existing draft (same form, prefilled). Owner-gated; `notFound()`
  for non-owners or non-draft auctions.
- **`/auction/[id]` reused for preview** — when the auction is a `draft` and the viewer is the
  owner, render the detail page in read-only **Preview** mode: a "Draft — not yet live" banner
  and a **Publish** button in place of the bid panel. Non-owners or non-draft auctions fall
  through to existing Slice 1 behavior (and a draft is `notFound()` for non-owners). Publish →
  `publish_listing` → redirect to the now-live auction.
- **Entry point:** a "Sell a vehicle" link in the header/nav, visible when logged in.

## 7. Media upload (real R2)

- **`POST /api/uploads/presign`** (server route): validates the request (content-type
  `image/*`, per-file size cap 10 MB, max 12 photos per listing), then returns a short-lived presigned
  PUT URL for R2 via the S3-compatible API using server-side credentials. The browser PUTs
  the file directly to R2; the resulting public object URL is stored in `photo_urls`.
- **Server-only env (documented in `.env.local.example`):** `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`. If unset, the
  route returns `503 r2_not_configured` so the failure is legible.
- **Dependency call-out (deliberate choice):** real-R2-only means the photo step — and the
  create-flow e2e — require R2 credentials to function. The e2e points at an R2 **test bucket**
  via env and is **skipped with a clear reason** when creds are absent; the rest of the suite
  still runs. Presign unit tests mock the R2 client and need no creds.

## 8. Error handling

- Form validation errors are surfaced inline per field; the server action re-validates and
  returns field-level errors (never trusts the client).
- `publish_listing` rejections map to user-readable messages (e.g. "Your auction end time is
  in the past — pick a new time").
- Presign failures: `503 r2_not_configured` (config) and `400` (bad content-type/size) with
  clear messages; the uploader shows a retryable error state.
- Owner gating: drafts `notFound()` for non-owners on both the edit and preview routes.

## 9. Testing

- **Unit (vitest):** the shared validation module (every rule in §5); the presign route's
  input validation (R2 client mocked).
- **Integration (vitest vs local Supabase):** `create_draft_listing` (inserts vehicle +
  draft), `update_draft_listing` (rejects non-owner and non-draft), `publish_listing` (rejects
  non-owner / non-draft / past end_time / missing photos; succeeds → `live` with `start_time`).
- **e2e (Playwright):** logged-in dealer → `/sell` → fill form → upload a photo (R2 test
  bucket) → save draft → preview shows the "Draft" banner → Publish → auction appears live in
  the grid. Reuses the Slice 1 `globalSetup` DB reset. Skipped with a clear reason if R2 creds
  are absent.
- **Invariant checks:** a `draft` does not appear in `getLiveAuctions()` and is not in the
  realtime feed.

## 10. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via PR (never
push directly to `main`).
