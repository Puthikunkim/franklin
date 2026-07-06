# Slice 8 — Auction auto-close (expired auctions resolve without a /won visit)

**Status:** Design approved 2026-07-06
**Predecessors:** Slices 1 (hero auction flow), 2 (listing creation), 3 (dashboard), 4 (discovery), 5 (buy-now), 6 (unpublish), 7 (notifications), all merged to `main`.

## 1. Goal

Make auctions actually end when their timer runs out. Today `close_auction(id)` — the only
thing that moves a `live` auction to `sold`/`passed`, writes the settlement, and (since
Slice 7) fires the `won`/`sold` notifications — runs **only** when someone loads
`/won/[id]`. So an auction past its `end_time` but not yet closed is a zombie: it still shows
on the home grid (`search_live_auctions` filters on `status='live'`, not `end_time`) with a
0:00 countdown; the winner gets no `won` notification and there's no settlement row; the seller
sees nothing in "My sales" and gets no `sold` notification — until someone happens to open the
won page. (Bidding is already correctly blocked: `place_bid` guards `end_time <= now()`.)

This slice closes expired auctions on read, so wins, sales, settlements, and notifications
materialize reliably.

## 2. Scope

**In scope:**
- A `close_expired_auctions()` sweep RPC that closes every expired `live` auction by reusing
  the existing `close_auction(id)` per-auction logic.
- Invoking the sweep at the top of the home grid and dashboard render paths.
- A defensive `end_time > now()` filter on `search_live_auctions` so an expired auction is
  never shown as bidable even before a sweep runs.
- A `closeExpiredAuctions(sb)` service wrapper.

**Out of scope (rejected / later):** a real scheduler (`pg_cron` or external cron) — untestable
in the local-DB model and adds infra; changing `getMyWins`/`getMySales` query logic (the sweep
plus the existing queries already work); any new UI; per-auction "ended" banner redesign. No
credential-dependent work — this slice needs none.

## 3. Product decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Close mechanism | **Close-on-read sweep**: a set-based writer closes every expired live auction, reusing `close_auction`. No scheduler, no new infra, directly testable, self-healing on any page load. |
| Sweep placement | The **home grid** render and the **dashboard** render, each before their reads. `/won/[id]` keeps its existing per-auction `close_auction` (deep-link + belt-and-suspenders). |
| DRY | The sweep loops `close_auction(id)`; the sold/passed/settlement/notification logic stays in one place (`close_auction`). |
| Grants | The sweep is **anon/authenticated-callable**, mirroring `close_auction`. It is a *system* operation (no dealer identity, idempotent, only advances genuinely-expired auctions to their inevitable state), so anon-callable is correct and does **not** conflict with the service_role-only pattern that governs *dealer* writers (create/update/publish/discard/buy_now/unpublish/set_watch/mark_notifications_read). |
| Grid correctness | Add `and a.end_time > now()` to `search_live_auctions` so an expired auction never appears as live, independent of the sweep. |

## 4. The sweep RPC

New migration `supabase/migrations/0010_auto_close.sql`.

```sql
create or replace function close_expired_auctions() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id from auctions
    where status = 'live' and end_time <= now()
    for update skip locked        -- don't block on an in-flight bid or a concurrent sweep
  loop
    perform close_auction(r.id);   -- reuse ALL existing logic (reserve→sold+settlement+won/sold notifs, else passed)
    n := n + 1;
  end loop;
  return n;                        -- number of auctions closed (observability + test assertions)
end; $$;

grant execute on function close_expired_auctions() to anon, authenticated;
```

- **`SECURITY DEFINER` is required:** `select … for update` needs the owner's UPDATE privilege
  on `auctions` (anon has SELECT only). Running as owner, the lock and the nested
  `close_auction` writes succeed.
- **`for update skip locked`:** an auction currently locked by an in-flight `place_bid` (or a
  concurrent sweep) is skipped this pass and picked up on the next one — no contention, no
  deadlock. `close_auction`'s own `select … for update` re-locks the already-held row and
  re-checks its guards (`status <> 'live'` / `end_time > now()`), so the sweep is safe and
  idempotent even under races.
- No new table or column. `close_auction`, `settlements`, and the `notifications` generation
  are unchanged — the sweep only *calls* the existing writer.

## 5. Grid correctness — `search_live_auctions`

Redefine `search_live_auctions` (originally migration 0006) in `0010_auto_close.sql`, adding a
single predicate:

```
where a.status = 'live'
  and a.end_time > now()     -- NEW: never surface an auction whose timer has run out
  and ( … existing q/grade/price/region predicates unchanged … )
```

All other clauses, the multi-`CASE` ordering, and the grant are reproduced verbatim. No test
impact: `test_reset` future-dates every seeded non-draft auction (`end_time = now() + 2h`), so
every discovery assertion's expected live set is unchanged.

## 6. Service + wiring

- **Service** `closeExpiredAuctions(sb: SupabaseClient): Promise<number>` — added to
  `src/lib/auctions.ts` (DI: pages pass `await serverClient()`, tests pass `admin`).
  `const { data } = await sb.rpc("close_expired_auctions"); return (data as number) ?? 0;`.
- **Home grid** (`src/app/page.tsx`) — `await closeExpiredAuctions(sb)` immediately after
  building `sb`, before the `searchLiveAuctions`/`getWatchedAuctionIds` reads.
- **Dashboard** (`src/app/dashboard/page.tsx`) — `await closeExpiredAuctions(sb)` immediately
  after building `sb`, before the activity reads.
- **`/won/[id]`** unchanged — still calls `close_auction(id)` for the specific auction on
  render (handles a direct deep-link and remains a correct fallback).

This is the same "mutation during a GET render" pattern already used by `/won/[id]`
(`close_auction`) and Slice 7's `/notifications` (`mark_notifications_read`). The sweep is a
no-op when nothing is expired (the `WHERE` matches no rows), so the per-render cost is one cheap
indexed query.

## 7. Error handling

- The sweep is idempotent and self-healing: a transient failure (or a row skipped under
  `skip locked`) simply resolves on the next page load. Each `close_auction` call is guarded, so
  a race between the sweep's select and the nested lock can never sell/pass a wrong-state auction.
- Notifications/settlement are produced by the unchanged `close_auction` inside the same
  transaction as each row's status change — a `won`/`sold` row exists iff that auction actually
  closed as sold.
- Reads on the home/dashboard pages happen after the sweep, so those pages reflect the
  just-closed state within the same request.

## 8. Testing

- **Integration (vitest vs local Supabase):** own-fixture hygiene (`createLiveAuction` +
  `deleteAuctions`, `beforeEach(resetDb)`). New file `tests/close_expired.test.ts`:
  - An expired auction whose price meets reserve closes as `sold`, writes the settlement, and
    fires `won` (winner) + `sold` (seller) notifications. (Push price above reserve via the
    proxy engine: leader max 1,300,000, challenger max 1,250,000 → price 1,275,000 ≥ reserve
    1,200,000, leader unchanged so no stray `outbid`; then `test_set_end_in_seconds(id, -1)`.)
  - An expired auction with no bid (or below reserve) closes as `passed` — no settlement, no
    notifications.
  - A non-expired live auction (default `end_time`) is left `live`.
  - Multiple expired auctions close in one call; `close_expired_auctions()` returns the count.
  - Idempotent: a second call returns 0 and changes nothing.
  - Anon may execute `close_expired_auctions()` (mirrors `close_auction`; the home page calls it
    via the anon client).
  - `search_live_auctions` excludes an expired-but-unswept live auction (create live, set
    `end_time` in the past, do **not** sweep, assert it is absent from results) — proves the
    defensive filter independently of the sweep.
- **e2e (Playwright):** new `tests/e2e/auto-close.spec.ts`. Using the service-role `admin`
  client (as `global-setup` already does with Supabase), set the SPARE `a09` (VW Golf, seller
  D4 — no other spec needs it live) to `test_set_end_in_seconds(a09, -1)`, then log in, load
  `/`, and assert the VW Golf card is **absent** from the grid — the home-render sweep closed it.
  a09 has no bids, so it closes to `passed`: no settlement, no notifications, no cross-spec
  pollution. `listing.spec` stays skipped (R2).
- **Interaction note:** once the home page sweeps on every load, any auction whose *seed*
  end-time elapses mid-run is closed the next time any spec loads `/`. No spec depends on the
  short-window seeded auctions (a07 +20m, a08 +10m, a09 +5m) staying live; the auctions specs
  *do* require live (a01 +2h, a02 +90m, a03 +75m, a05 +45m, a06 +30m) all outlast a normal
  multi-minute e2e run. If a run ever approaches 30 min, bump the short seed end-times.
- **Invariant:** an auction with `end_time <= now()` never appears in the live grid, and always
  resolves to `sold`/`passed` (with its settlement + notifications) on the next home/dashboard
  load — no `/won` visit required.

## 9. Workflow note

Implementation continues to target Claude Code web on a phone: small, well-bounded files,
managed services over self-hosted infra, repo as the single source of truth. Commits are a
single line with no co-author trailer; work on a feature branch and integrate via merge at
completion (never commit WIP directly to `main`). Credential-dependent tests stay deferred until
the app is code-complete — this slice adds none. The full vitest suite runs sequentially
(`fileParallelism: false`) because integration tests share one local Supabase DB; new
integration tests reset/clean their own state and scope global assertions to seeded ids. e2e
specs run with `workers: 1` and a *fresh* dev server per full run.
