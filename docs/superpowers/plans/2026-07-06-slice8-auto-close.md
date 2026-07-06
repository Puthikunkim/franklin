# Slice 8 — Auction Auto-Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close auctions whose timer has run out without depending on a `/won/[id]` visit, so wins, sales, settlements, and `won`/`sold` notifications materialize reliably.

**Architecture:** A `close_expired_auctions()` sweep RPC batches over expired `live` auctions and calls the existing `close_auction(id)` for each (reusing all sold/passed/settlement/notification logic). It's invoked at the top of the home grid and dashboard renders. `search_live_auctions` gains a defensive `end_time > now()` filter so an expired auction is never shown as bidable.

**Tech Stack:** Next.js 16 (App Router, RSC server components), Supabase local (Postgres + PostgREST), TypeScript, Vitest (integration vs local DB), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-06-slice8-auto-close-design.md`
**Branch:** `feat/slice8-auto-close` (already created; design committed at `5da3e1d`).

## Global Constraints

- **Money:** integer cents everywhere.
- **DRY:** the sweep loops `close_auction(id)`; sold/passed/settlement/notification logic stays only in `close_auction`. Do NOT reimplement it.
- **Sweep security:** `close_expired_auctions()` is `security definer set search_path = public` (needs the owner's UPDATE privilege for `select … for update`), uses `for update skip locked`, and is granted `execute` to `anon, authenticated` — mirroring `close_auction`. It is a *system* operation (no dealer identity, idempotent, only advances genuinely-expired auctions), so anon-callable is correct and does NOT conflict with the service_role-only pattern that governs dealer writers. Do NOT revoke PUBLIC (matches `close_auction`, which the home/dashboard pages call via the anon client).
- **`search_live_auctions` grant:** `CREATE OR REPLACE FUNCTION` preserves the existing 0006 grant to `anon, authenticated` — do not re-grant, do not revoke.
- **DI pattern:** `closeExpiredAuctions(sb: SupabaseClient)` takes the client (pages pass `await serverClient()`, tests pass `admin`).
- **Mutation-during-render:** invoking the sweep in a server-component render is the established pattern (`/won/[id]` calls `close_auction`; `/notifications` calls `mark_notifications_read`). Before editing a page, read the relevant App Router guide under `node_modules/next/dist/docs/` (AGENTS.md: "This is NOT the Next.js you know").
- **Vitest:** shared single local DB, `fileParallelism: false`. New integration tests reset/clean their own state (`beforeEach(resetDb)`, `afterEach(deleteAuctions(...))`) and scope assertions to their own fixtures.
- **Playwright:** `workers: 1`; a FRESH dev server per full run. `listing.spec.ts` stays skipped (R2).
- **Commits:** single line, no co-author trailer. Work only on `feat/slice8-auto-close` (never `main`).
- **No credentials:** this slice adds none.

## File Structure

- **Create** `supabase/migrations/0010_auto_close.sql` — `close_expired_auctions()` sweep RPC + grant; `search_live_auctions` redefined with the `end_time > now()` filter.
- **Modify** `src/lib/auctions.ts` — add `closeExpiredAuctions(sb)`.
- **Modify** `src/app/page.tsx` — invoke the sweep before the grid reads.
- **Modify** `src/app/dashboard/page.tsx` — invoke the sweep before the activity reads.
- **Create tests:** `tests/close_expired.test.ts` (Task 1 — sweep RPC + defensive filter), `tests/close_expired_service.test.ts` (Task 2 — the lib wrapper), `tests/e2e/auto-close.spec.ts` (Task 3).

**Seed ids referenced:** dealers D1 `11111111-1111-1111-1111-111111111111`, D2 `22222222-2222-2222-2222-222222222222`, D3 `33333333-3333-3333-3333-333333333333`, D4 `44444444-4444-4444-4444-444444444444`. Auction a09 `a0000000-0000-0000-0000-000000000a09` (Volkswagen Golf 2020, seller D4, live, ends +5min). `createLiveAuction(seller)` builds a Kia Sportage: starting 1,000,000 / reserve 1,200,000 / buy_now 1,500,000 / end +2 days.

---

### Task 1: `close_expired_auctions()` sweep RPC + `search_live_auctions` filter

**Files:**
- Create: `supabase/migrations/0010_auto_close.sql`
- Test: `tests/close_expired.test.ts`

**Interfaces:**
- Consumes: existing `close_auction(uuid)` (unchanged), `place_bid`, `test_set_end_in_seconds`, `createLiveAuction`/`deleteAuctions`.
- Produces (SQL): `close_expired_auctions() returns int` (anon/authenticated-callable); `search_live_auctions(...)` now excludes `end_time <= now()`.

- [ ] **Step 1: Write the failing test**

Create `tests/close_expired.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333"; // fixture seller (never a bidder)

const created: string[] = [];
async function makeLive(): Promise<string> {
  const id = await createLiveAuction(D3);
  created.push(id);
  return id;
}
async function bid(auction: string, dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", { p_auction_id: auction, p_dealer_id: dealer, p_max_amount: max });
  if (error) throw error;
}
async function expire(auction: string) {
  const { error } = await admin.rpc("test_set_end_in_seconds", { p_auction_id: auction, p_seconds: -1 });
  if (error) throw error;
}
async function sweep(): Promise<number> {
  const { data, error } = await admin.rpc("close_expired_auctions");
  if (error) throw error;
  return data as number;
}
async function statusOf(id: string): Promise<string> {
  const { data } = await admin.from("auctions").select("status").eq("id", id).single();
  return data!.status as string;
}
async function notifs(recipient: string, type: string) {
  const { data } = await admin.from("notifications").select("id")
    .eq("recipient_dealer_id", recipient).eq("type", type);
  return data ?? [];
}

describe("close_expired_auctions", () => {
  beforeEach(resetDb); // future-dates every seeded auction, so only our expired fixtures get swept
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("closes an expired reserve-met auction as sold with settlement + won/sold notifications", async () => {
    const id = await makeLive();
    await bid(id, D1, 1300000);   // D1 leads at the 1,000,000 starting price
    await bid(id, D2, 1250000);   // below D1's proxy → D1 holds, price rises to 1,275,000 (>= reserve), no outbid row
    await expire(id);
    expect(await sweep()).toBe(1);
    expect(await statusOf(id)).toBe("sold");
    const { data: s } = await admin.from("settlements").select("sale_price").eq("auction_id", id).single();
    expect(s!.sale_price).toBe(1275000);
    expect((await notifs(D1, "won")).length).toBe(1);
    expect((await notifs(D3, "sold")).length).toBe(1);
  });

  it("closes an expired no-bid auction as passed with no settlement or notifications", async () => {
    const id = await makeLive();
    await expire(id);
    await sweep();
    expect(await statusOf(id)).toBe("passed");
    const { data: s } = await admin.from("settlements").select("id").eq("auction_id", id);
    expect(s!.length).toBe(0);
    expect((await notifs(D3, "sold")).length).toBe(0);
  });

  it("leaves a non-expired live auction untouched", async () => {
    const id = await makeLive(); // default end_time = now + 2 days
    await sweep();
    expect(await statusOf(id)).toBe("live");
  });

  it("closes multiple expired auctions in one call and returns the count", async () => {
    const a = await makeLive();
    const b = await makeLive();
    await expire(a); await expire(b);
    expect(await sweep()).toBe(2);
    expect(await statusOf(a)).not.toBe("live");
    expect(await statusOf(b)).not.toBe("live");
  });

  it("is idempotent — a second sweep closes nothing new", async () => {
    const id = await makeLive();
    await expire(id);
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await statusOf(id)).not.toBe("live");
  });

  it("is callable by the anon (browser) role", async () => {
    const { error } = await anon.rpc("close_expired_auctions");
    expect(error).toBeNull();
  });

  it("search_live_auctions excludes an expired-but-unswept live auction", async () => {
    const id = await makeLive();
    await expire(id); // still status='live', just past end_time; do NOT sweep
    const { data } = await admin.rpc("search_live_auctions", {
      p_q: null, p_grades: null, p_min_price: null, p_max_price: null, p_region: null, p_sort: null,
    });
    const ids = (data as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/close_expired.test.ts`
Expected: FAIL — `close_expired_auctions` does not exist yet (RPC error), and the filter test would also fail because the expired auction is still returned.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0010_auto_close.sql`:

```sql
-- Slice 8: auto-close. Resolve auctions whose timer has run out without depending on a
-- /won/[id] visit. close_expired_auctions() batches over expired live auctions and calls the
-- existing close_auction(id) for each, so sold/passed + settlement + won/sold notifications
-- stay defined in ONE place (close_auction). search_live_auctions gains a defensive end_time
-- filter so an expired auction is never shown as bidable, independent of the sweep.

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
    perform close_auction(r.id);   -- reuse reserve→sold+settlement+won/sold notifs, else passed
    n := n + 1;
  end loop;
  return n;
end; $$;

-- System operation (no dealer identity, idempotent, only advances genuinely-expired auctions):
-- anon/authenticated-callable, mirroring close_auction. The home/dashboard server components
-- invoke it via the anon client during render. PUBLIC's default execute is intentionally left
-- in place (as with close_auction).
grant execute on function close_expired_auctions() to anon, authenticated;

-- Redefine search_live_auctions (originally 0006) with a defensive end_time > now() filter.
-- All other clauses, the ordering, and (via CREATE OR REPLACE) the 0006 grant to
-- anon/authenticated are preserved verbatim.
create or replace function search_live_auctions(
  p_q text default null,
  p_grades vehicle_grade[] default null,
  p_min_price int default null,
  p_max_price int default null,
  p_region text default null,
  p_sort text default null
) returns setof auctions
language sql stable security invoker as $$
  select a.*
  from auctions a
  join vehicles v on v.id = a.vehicle_id
  join dealers d on d.id = a.seller_dealer_id
  where a.status = 'live'
    and a.end_time > now()
    and (p_q is null or p_q = '' or
         v.make ilike '%' || p_q || '%' or
         v.model ilike '%' || p_q || '%' or
         coalesce(v.variant, '') ilike '%' || p_q || '%')
    and (p_grades is null or array_length(p_grades, 1) is null or v.grade = any(p_grades))
    and (p_min_price is null or coalesce(a.current_bid, a.starting_price) >= p_min_price)
    and (p_max_price is null or coalesce(a.current_bid, a.starting_price) <= p_max_price)
    and (p_region is null or p_region = '' or d.region = p_region)
  order by
    case when p_sort = 'price_asc'  then coalesce(a.current_bid, a.starting_price) end asc,
    case when p_sort = 'price_desc' then coalesce(a.current_bid, a.starting_price) end desc,
    case when p_sort = 'newest'     then a.start_time end desc,
    a.end_time asc;  -- default (ending_soon) and deterministic tiebreaker for all sorts
$$;
```

- [ ] **Step 4: Apply the migration and run the test**

Run: `npx supabase db reset && npx vitest run tests/close_expired.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify discovery still passes (the new filter must not change seeded live sets)**

Run: `npx vitest run tests/discovery_search.test.ts tests/discovery.test.ts`
Expected: PASS — `test_reset` future-dates every seeded auction, so `end_time > now()` excludes none of them.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0010_auto_close.sql tests/close_expired.test.ts
git commit -m "Add close_expired_auctions sweep and exclude expired auctions from search_live_auctions"
```

---

### Task 2: `closeExpiredAuctions` service + wire into home + dashboard renders

**Files:**
- Modify: `src/lib/auctions.ts` (add `closeExpiredAuctions`)
- Modify: `src/app/page.tsx` (invoke before grid reads)
- Modify: `src/app/dashboard/page.tsx` (invoke before activity reads)
- Test: `tests/close_expired_service.test.ts`

**Interfaces:**
- Consumes: `close_expired_auctions()` RPC (Task 1); `serverClient()`.
- Produces: `closeExpiredAuctions(sb: SupabaseClient): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Create `tests/close_expired_service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { closeExpiredAuctions } from "@/lib/auctions";

const D3 = "33333333-3333-3333-3333-333333333333";
const created: string[] = [];

describe("closeExpiredAuctions service", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("closes expired auctions and returns the count", async () => {
    const id = await createLiveAuction(D3); created.push(id);
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const n = await closeExpiredAuctions(admin);
    expect(n).toBe(1);
    const { data } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(data!.status).toBe("passed"); // no bids → passed
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/close_expired_service.test.ts`
Expected: FAIL — `closeExpiredAuctions` is not exported from `@/lib/auctions`.

- [ ] **Step 3: Add the service function**

Edit `src/lib/auctions.ts`. Add the import at the top and the function below `getAuctionById` (leave `getAuctionById` unchanged):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
```

```ts
// Close every auction whose timer has run out (reuses close_auction per row via the
// close_expired_auctions() sweep). Called at the top of the home/dashboard renders so
// wins/sales/settlements/notifications materialize without a /won visit. Returns the count.
export async function closeExpiredAuctions(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.rpc("close_expired_auctions");
  return (data as number) ?? 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/close_expired_service.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Wire the sweep into the home grid**

Edit `src/app/page.tsx`. Add the import (alongside the existing `@/lib/...` imports):

```ts
import { closeExpiredAuctions } from "@/lib/auctions";
```

Then invoke the sweep immediately after `sb` is created, before the reads. Change:

```ts
  const sb = await serverClient();
  const [auctions, watchedIds] = await Promise.all([
```

to:

```ts
  const sb = await serverClient();
  await closeExpiredAuctions(sb); // resolve any expired auctions before querying the grid
  const [auctions, watchedIds] = await Promise.all([
```

- [ ] **Step 6: Wire the sweep into the dashboard**

Edit `src/app/dashboard/page.tsx`. Add the import (alongside the existing `@/lib/...` imports):

```ts
import { closeExpiredAuctions } from "@/lib/auctions";
```

Then invoke the sweep immediately after `sb` is created, before the reads. Change:

```ts
  const sb = await serverClient();
  const [listings, bidding, wins, sales, watching] = await Promise.all([
```

to:

```ts
  const sb = await serverClient();
  await closeExpiredAuctions(sb); // resolve expired auctions so My sales / My wins are current
  const [listings, bidding, wins, sales, watching] = await Promise.all([
```

- [ ] **Step 7: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; both `/` and `/dashboard` compile.

- [ ] **Step 8: Commit**

```bash
git add src/lib/auctions.ts src/app/page.tsx src/app/dashboard/page.tsx tests/close_expired_service.test.ts
git commit -m "Sweep expired auctions on the home grid and dashboard renders"
```

---

### Task 3: e2e auto-close + full green

**Files:**
- Create: `tests/e2e/auto-close.spec.ts`

**Interfaces:**
- Consumes: the running app + a fresh DB (Playwright `globalSetup` resets once); the service-role `admin` client from `tests/helpers/db.ts` and `test_set_end_in_seconds`.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/auto-close.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { admin } from "../helpers/db";

// Prove the render-time sweep: force the SPARE a09 (Volkswagen Golf, seller D4 — no other e2e
// spec needs it live) to expire, then load the home grid and assert it's gone (the home-render
// close_expired_auctions() closed it). a09 has no bids → closes to 'passed' (no settlement, no
// notifications), so no cross-spec pollution. This spec sorts alphabetically FIRST, so it runs
// right after globalSetup's reset while a09 is still freshly live.
const A09 = "a0000000-0000-0000-0000-000000000a09";

test("an expired auction is auto-closed and drops off the live grid on load", async ({ page }) => {
  // Expire a09 via the service-role client (mirrors how global-setup manages DB state).
  const { error } = await admin.rpc("test_set_end_in_seconds", { p_auction_id: A09, p_seconds: -1 });
  expect(error).toBeNull();

  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click();
  await expect(page).toHaveURL("/");

  // The home render swept expired auctions before querying the grid, so the Golf is absent.
  await expect(page.getByRole("heading", { name: /Volkswagen Golf/ })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the full vitest suite (clean DB) — everything green**

Run: `npx supabase db reset && npm test`
Expected: all test files pass, including `tests/close_expired.test.ts` and `tests/close_expired_service.test.ts`. Report the totals.

- [ ] **Step 3: Run the full Playwright suite against a fresh dev server**

Ensure nothing is bound to port 3000 (bash: `netstat -ano | grep ':3000' | grep LISTENING`; if found, `taskkill //PID <pid> //F`), then run:

Run: `npm run test:e2e`
Expected: all specs pass (`auto-close.spec.ts` included), `listing.spec.ts` skipped. Playwright manages a fresh dev server + one `globalSetup` reset. If a spec flakes, note which and re-run once; do not weaken assertions.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/auto-close.spec.ts
git commit -m "Add e2e covering render-time auto-close of an expired auction"
```

---

## Self-Review

**1. Spec coverage:**
- §4 sweep RPC (`close_expired_auctions`, `security definer`, `for update skip locked`, loops `close_auction`, returns count, anon grant) → Task 1. ✓
- §5 defensive `end_time > now()` filter on `search_live_auctions` → Task 1 (migration + the exclusion test + discovery regression check). ✓
- §6 service `closeExpiredAuctions(sb)` + wiring into home & dashboard before reads; `/won` unchanged → Task 2. ✓
- §8 integration cases (sold+settlement+won/sold, passed+none, non-expired untouched, multiple+count, idempotent, anon-callable, filter-excludes) → Task 1; service test → Task 2; e2e (expire a09 → gone from grid) → Task 3. ✓
- §3 anon-callable grant + DRY reuse of `close_auction` → Task 1 migration + Global Constraints. ✓

**2. Placeholder scan:** No TBD/TODO; every code step is complete; the e2e pins a09 with reasoning; exact proxy-bid amounts given for the sold case. ✓

**3. Type consistency:** `close_expired_auctions()` (no args, returns int) is used identically in the migration, `tests/close_expired.test.ts`, and the `closeExpiredAuctions` service. `closeExpiredAuctions(sb)` name/signature matches between `src/lib/auctions.ts`, its service test, and both page call sites. `test_set_end_in_seconds(p_auction_id, p_seconds)` and `createLiveAuction`/`deleteAuctions`/`resetDb`/`admin`/`anon` all match `tests/helpers/db.ts`. The sold-case arithmetic is verified: leader max 1,300,000, challenger max 1,250,000 → proxy holds, price = least(1,250,000 + 25,000, 1,300,000) = 1,275,000 ≥ reserve 1,200,000, leader unchanged (no `outbid` row), so the close yields `won`(D1)+`sold`(D3) and a settlement of 1,275,000. ✓

**Note on the `search_live_auctions` grant:** `CREATE OR REPLACE FUNCTION` preserves the 0006 grant to `anon, authenticated` (same precedent as 0009 redefining the writers without re-granting) — no re-grant is in the migration by design; the migration comment states this.
