# Slice 9 — Dealer profiles & trust

**Status:** Design approved 2026-07-06
**Predecessors:** Slices 1 (hero auction flow), 2 (listing creation), 3 (dashboard), 4 (discovery), 5 (buy-now), 6 (unpublish), 7 (notifications), 8 (auto-close), all merged to `main`.

## 1. Goal

Let a buyer vet who they're bidding against. A `/dealer/[id]` profile page surfaces a seller's
trust signals (verified badge, rating, region, license) and track record (their live listings +
completed sales), all from data that already exists on the `dealers`/`auctions`/`settlements`
tables but is shown nowhere. Reachable by clicking the seller on an auction detail page.

## 2. Scope

**In scope:**
- A `/dealer/[id]` server-rendered profile page (login-required, any dealer may view any dealer).
- `src/lib/dealers.ts` read functions: the dealer row, their live listings, their completed sales.
- A trust header (initials, name, verified ✓, ★ rating, region, license, "N completed sales"),
  a live-listings grid (reusing `AuctionCard`), and a sales-history list (vehicle · price · date).
- Making the seller `DealerBadge` on the auction detail page a link to the profile.

**Out of scope (later / rejected):** a real rating mechanism or buyer reviews (we surface only
the existing static `rating`); editing your own profile; "member since" (no `created_at` on
`dealers`); showing `passed` (unsold) auctions in the sales history; linking the badge from
inside `AuctionCard` (the card is already an `<a>` — nested anchors are invalid HTML). No
credential-dependent work — this slice needs none, and adds **no migration** (all fields exist).

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Sales-history granularity | Full transparency: a headline "N completed sales" plus each sold vehicle with its **sale price and sold date**. Consistent with the app already showing live current bids and the `/won` settlement to any logged-in dealer. |
| Rating | Surface the existing **static** `dealers.rating` (e.g. "★ 4.8"). No review/rating system — that's a separate, larger feature. |
| Access | **Login-required**, and any logged-in dealer may view any dealer's profile ("public within the platform" — the whole B2B app sits behind login). Unknown id → 404. |
| Entry point | The seller `DealerBadge` on the **auction detail page** links to `/dealer/[seller.id]`. `AuctionCard`'s badge stays non-link (nested-anchor constraint). |
| Sales shown | Only `status = 'sold'` auctions (a completed-sales track record). `passed` (unsold) excluded. |
| Data access | Plain PostgREST reads via `serverClient()` — anon already has SELECT on `dealers`/`auctions`/`vehicles`/`settlements`. No new RPC, grant, table, or column. |

## 4. Data — `src/lib/dealers.ts`

DI `(sb: SupabaseClient, id: string)` pattern (pages pass `await serverClient()`, tests pass
`admin`), mirroring `src/lib/dashboard.ts`/`discovery.ts`.

- **`getDealer(sb, id): Promise<Dealer | null>`** — `from("dealers").select("*").eq("id", id).maybeSingle()`.
  `null` → the page calls `notFound()`.
- **`getDealerLiveListings(sb, id): Promise<any[]>`** — `from("auctions")` with the
  `"*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)"` join,
  `.eq("seller_dealer_id", id).eq("status","live").gt("end_time", new Date().toISOString())`,
  ordered `end_time` ascending (ending soonest first). The `seller` join lets the page reuse
  `AuctionCard`. Excludes drafts, sold/passed, and expired-but-unswept auctions.
- **`getDealerSales(sb, id): Promise<any[]>`** — `from("auctions")` with
  `"*, vehicle:vehicles(*), settlement:settlements(*)"`, `.eq("seller_dealer_id", id)
  .eq("status","sold")`, ordered `end_time` descending (most recent first). The count is the
  list length.

## 5. UI — `src/app/dealer/[id]/page.tsx`

Server component. `getDealerId()` → `redirect("/login")` if absent. `const { id } = await params`
(Next.js 16: `params` is a Promise). Fetch the dealer (→ `notFound()` if null), their live
listings, their sales, and the viewer's watched-auction ids (for `AuctionCard`). Renders
`<Header />` then three sections:

1. **Trust header** — initials avatar (reuse the `DealerBadge` styling idiom), business name,
   verified ✓ when `is_verified`, "★ {rating}" (the static field, one decimal), region, license
   no (`dealer_license_no`), and a headline "**{sales.length} completed sales**".
2. **Live listings** — `<h2>Live listings</h2>` + a responsive grid of `AuctionCard`
   (`watched={watchedIds.has(a.id)}`), or an empty state "No live listings right now."
3. **Sales history** — `<h2>Sales history</h2>` + a list; each row: `{year make model}`,
   `formatNZD(settlement.sale_price)`, and the sold date from `end_time` (formatted `en-NZ`).
   Empty state "No completed sales yet." (`settlement` may be an array from the embed — read
   `Array.isArray(s) ? s[0] : s`, as `dashboard/page.tsx` already does for `getMySales`).

`vehicleLabel(v) = \`${v.year} ${v.make} ${v.model}\`` (same helper idiom as dashboard).

## 6. Entry point — auction detail seller link

In `src/app/auction/[id]/page.tsx`, the "Seller" section currently renders
`<DealerBadge dealer={seller} />`. Wrap it in a `Link`:
`<Link href={\`/dealer/${seller.id}\`}><DealerBadge dealer={seller} /></Link>`. This is the one
call site where the badge is not already inside another anchor, so it's valid. `DealerBadge`
itself is unchanged.

## 7. Error handling

- No dealer cookie → `redirect("/login")` before any read.
- Unknown/`maybeSingle()`-null dealer id → `notFound()` (renders the standard 404).
- `getDealerLiveListings` filters `end_time > now()`, so an expired-but-unswept auction never
  appears as a live listing even though the page doesn't run the Slice 8 sweep itself.
- Empty states for both the live-listings and sales-history sections.

## 8. Testing

- **Integration (vitest vs local Supabase):** own-fixture hygiene (`createLiveAuction` +
  `deleteAuctions`, `beforeEach(resetDb)`) where a mutation is needed; read-only cases may use
  seeded rows scoped by dealer id.
  - `getDealer` returns the seeded dealer row (name, `rating`, `is_verified`, region, license)
    for a known id, and `null` for an unknown id.
  - `getDealerLiveListings(D1)` returns only dealer 1's live, future auctions (the seeded
    Corolla `a01` + Hilux `a06` after reset) and excludes their seeded **draft** (`a…d1`); a
    created auction belonging to a *different* dealer is not returned.
  - `getDealerSales(D1)`: with a created fixture — `createLiveAuction(D1)` → `place_bid` above
    reserve → `test_set_end_in_seconds(-1)` → `close_auction` → the sale appears with the
    correct `settlement.sale_price`; a `live` or `passed` fixture does **not** appear.
- **e2e (Playwright):** log in, open the seeded anchor auction `a01` (seller = Auckland Motor
  Wholesale / D1), click the seller badge/link → land on `/dealer/[D1]`, and assert the profile
  shows "Auckland Motor Wholesale", the verified indicator, and one of D1's live listings
  (Toyota Corolla). No auction state is mutated, so this spec is order-independent. `listing.spec`
  stays skipped (R2).
- **Invariant:** the profile shows only that dealer's own live (`status='live'`, future) auctions
  and only their completed (`sold`) sales; a draft, an expired-unswept auction, a passed auction,
  or another dealer's auction never appears.

## 9. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via merge at
completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred until
the app is code-complete — this slice adds none. The full vitest suite runs sequentially
(`fileParallelism: false`) because integration tests share one local Supabase DB; new
integration tests reset/clean their own state and scope global assertions to seeded ids. e2e
specs run with `workers: 1` and a *fresh* dev server per full run.
