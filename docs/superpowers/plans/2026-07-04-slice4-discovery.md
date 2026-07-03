# Slice 4 — Discovery (search, filter, sort + watchlist) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live-auctions grid searchable/filterable/sortable and let dealers watch auctions, with a "Watching" section on their dashboard.

**Architecture:** A single migration adds a `search_live_auctions` SQL function (read, `security invoker`, anon-callable), a `watchlist` table, and a `service_role`-only `set_watch` writer RPC. A DI read module (`src/lib/discovery.ts`) wraps the search + watch reads. The home grid becomes an async server component driven by URL search params through a client `FilterBar`. A `WatchButton` (client) posts a `"use server"` toggle action that writes via the service-role client using the httpOnly `dealer_id` cookie for identity.

**Tech Stack:** Next.js 16 (App Router, RSC, server actions, `await searchParams`), React 19 (`useActionState`), Supabase local (Postgres + PostgREST), Vitest (integration vs local DB), Playwright (e2e).

## Global Constraints

- **Next.js is non-standard here.** Before writing any route/page/action code, read the relevant guide under `node_modules/next/dist/docs/` (this Next.js differs from training data). Specific docs are cited per task.
- **Money is integer cents** everywhere in the DB and service layer. Only the `FilterBar` price inputs and the URL `?min=`/`?max=` params are in **whole dollars**; `parseFilters` is the *single* place that converts dollars → cents.
- **Writer RPC security pattern (mandatory):** Postgres grants `EXECUTE` to `PUBLIC` by default and `anon`/`authenticated` inherit it. Every writer function MUST `revoke execute ... from public, anon, authenticated;` **before** `grant execute ... to service_role;`. `search_live_auctions` is an intentional read → anon-callable; `set_watch` is a writer → service_role only.
- **New tables need explicit grants** (no RLS in this project): `grant select ... to anon, authenticated;` for reads and `grant select, insert, update, delete ... to service_role;`.
- **The service-role client is server-only.** Never import `@/lib/supabase/service` (or `@/lib/watch/service`) into a `"use client"` module. Seller/dealer identity always comes from the httpOnly `dealer_id` cookie server-side, never client input.
- **DI for testability:** read functions take `(sb: SupabaseClient, ...)` so tests pass the `admin` client; pages pass `await serverClient()`. `serverClient()` reads cookies and cannot run in Vitest.
- **Tests share ONE local Supabase DB** and run sequentially (`fileParallelism: false`, already set). New integration tests must reset/clean their own state in `beforeEach`.
- **Commits:** one line, no co-author trailer. Work on the existing branch `feat/slice4-discovery`; never commit to `main`.
- **No credential-dependent work** in this slice (no R2/external creds). The e2e runs (no photo upload involved).

---

## File Structure

**Created:**
- `supabase/migrations/0006_discovery.sql` — `search_live_auctions` fn, `watchlist` table, `set_watch` RPC, grants.
- `src/lib/discovery.ts` — `parseFilters`, `searchLiveAuctions`, `getWatchedAuctionIds`, `getMyWatching`, `REGIONS`, `SORT_OPTIONS`, `AuctionFilters`.
- `src/lib/watch/service.ts` — `setWatch` (service-role writer wrapper).
- `src/lib/watch/actions.ts` — `toggleWatchAction` (`"use server"`).
- `src/components/FilterBar.tsx` — client search/filter/sort controls.
- `src/components/WatchButton.tsx` — client heart toggle.
- `tests/discovery_search.test.ts` — `search_live_auctions` integration tests.
- `tests/watch_rpc.test.ts` — `set_watch` integration tests (incl. anon-denied).
- `tests/discovery.test.ts` — `parseFilters` (unit) + discovery reads (integration).
- `tests/watch_service.test.ts` — `setWatch` service integration test.
- `tests/e2e/discovery.spec.ts` — search → watch → dashboard → unwatch.

**Modified:**
- `src/app/page.tsx` — filtering (Task 4) + watched membership (Task 5).
- `src/components/AuctionCard.tsx` — restructure to host `WatchButton` (Task 5).
- `src/app/auction/[id]/page.tsx` — `WatchButton` for live auctions (Task 5).
- `src/app/dashboard/page.tsx` — 5th "Watching" section (Task 5).

---

## Task 1: Migration — search_live_auctions, watchlist, set_watch

**Files:**
- Create: `supabase/migrations/0006_discovery.sql`
- Test: `tests/discovery_search.test.ts`, `tests/watch_rpc.test.ts`

**Interfaces:**
- Consumes: existing `auctions`, `vehicles`, `dealers` tables; `vehicle_grade` enum (`A`–`E`); `place_bid`/`test_reset` helpers; seed data (9 live auctions `a0000000-…-000000000a01`…`a09`, 1 draft `a0000000-0000-0000-0000-0000000000d1`; dealers `1111…`–`5555…` in regions Auckland/Hamilton/Wellington/Christchurch/Tauranga).
- Produces:
  - `search_live_auctions(p_q text, p_grades vehicle_grade[], p_min_price int, p_max_price int, p_region text, p_sort text) returns setof auctions` — anon/authenticated EXECUTE. Live-only; price filters on `coalesce(current_bid, starting_price)` (cents); sorts `ending_soon`(default)/`price_asc`/`price_desc`/`newest`.
  - `watchlist(dealer_id uuid, auction_id uuid, created_at timestamptz, pk(dealer_id,auction_id))`, `auction_id` FK `on delete cascade`; anon SELECT.
  - `set_watch(p_dealer_id uuid, p_auction_id uuid, p_watched boolean) returns boolean` — service_role only; upsert on true (`on conflict do nothing`), delete on false; returns `p_watched`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0006_discovery.sql`:

```sql
-- Slice 4: discovery. Search over live auctions, plus a per-dealer watchlist.

-- ── Read: search/filter/sort over LIVE auctions ────────────────────────────────
-- Each param is optional (null / empty = no filter). Returns setof auctions so
-- callers re-join vehicle + seller with the existing pattern. security invoker:
-- anon already has SELECT on auctions/vehicles/dealers, so no privilege escalation.
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

grant execute on function search_live_auctions(text, vehicle_grade[], int, int, text, text)
  to anon, authenticated;

-- ── Watchlist table ────────────────────────────────────────────────────────────
create table watchlist (
  dealer_id  uuid not null references dealers(id),
  auction_id uuid not null references auctions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (dealer_id, auction_id)
);

grant select on watchlist to anon, authenticated;
grant select, insert, update, delete on watchlist to service_role;

-- ── Write: toggle a watch. service_role only. ──────────────────────────────────
create or replace function set_watch(p_dealer_id uuid, p_auction_id uuid, p_watched boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_watched then
    insert into watchlist (dealer_id, auction_id) values (p_dealer_id, p_auction_id)
    on conflict do nothing;
  else
    delete from watchlist where dealer_id = p_dealer_id and auction_id = p_auction_id;
  end if;
  return p_watched;
end; $$;

-- Writer is service-role only (Slice 2/3 pattern): revoke the PUBLIC default first.
revoke execute on function set_watch(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function set_watch(uuid, uuid, boolean) to service_role;
```

- [ ] **Step 2: Apply the migration to the local DB**

Run: `npx supabase db reset`
Expected: re-runs all migrations (incl. `0006`) + reseeds, ending with a success line (no errors). This is required before the integration tests can see the new function/table.

- [ ] **Step 3: Write the failing search tests**

Create `tests/discovery_search.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb } from "./helpers/db";

const DRAFT = "a0000000-0000-0000-0000-0000000000d1"; // seeded Nissan Navara draft

// Live seed auctions by id / seller / grade / starting_price(cents):
// a01 Toyota Corolla   D1 Auckland      B 600000
// a02 Mazda CX-5       D2 Hamilton      A 850000
// a03 Honda CR-V       D3 Wellington    B 700000
// a04 Subaru Forester  D4 Christchurch  A 1100000
// a05 Nissan Leaf      D5 Tauranga      A 1400000
// a06 Toyota Hilux     D1 Auckland      C 550000
// a07 Ford Ranger      D2 Hamilton      B 900000
// a08 Mitsubishi …PHEV D3 Wellington    A 1200000
// a09 VW Golf          D4 Christchurch  B 780000
const A = (n: string) => `a0000000-0000-0000-0000-000000000a0${n}`;

async function search(params: Record<string, unknown>) {
  const { data, error } = await admin.rpc("search_live_auctions", {
    p_q: null, p_grades: null, p_min_price: null, p_max_price: null,
    p_region: null, p_sort: null, ...params,
  });
  if (error) throw error;
  return (data ?? []) as { id: string; status: string; end_time: string; starting_price: number }[];
}

describe("search_live_auctions", () => {
  beforeEach(async () => { await resetDb(); }); // clear bids so current_bid is null

  it("text search matches make/model/variant, case-insensitively", async () => {
    const rows = await search({ p_q: "corolla" });
    expect(rows.map((r) => r.id)).toEqual([A("1")]);
  });

  it("grade filter returns only auctions of that grade", async () => {
    const rows = await search({ p_grades: ["A"] });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([A("2"), A("4"), A("5"), A("8")]));
  });

  it("price range filters on the current price (cents)", async () => {
    const rows = await search({ p_min_price: 1000000, p_max_price: 1300000 });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([A("4"), A("8")]));
  });

  it("region filter matches the seller dealer's region", async () => {
    const rows = await search({ p_region: "Auckland" });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([A("1"), A("6")]));
  });

  it("sort price_asc orders by current price ascending", async () => {
    const rows = await search({ p_sort: "price_asc" });
    const prices = rows.map((r) => r.starting_price);
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
  });

  it("default sort is ending_soon (end_time ascending)", async () => {
    const rows = await search({});
    const times = rows.map((r) => new Date(r.end_time).getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it("never returns a non-live auction (draft excluded)", async () => {
    const rows = await search({});
    expect(rows.every((r) => r.status === "live")).toBe(true);
    expect(rows.some((r) => r.id === DRAFT)).toBe(false);
  });
});
```

- [ ] **Step 4: Write the failing watch RPC tests**

Create `tests/watch_rpc.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, anon } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const ANCHOR = "a0000000-0000-0000-0000-000000000a01";

async function clearWatches() {
  await admin.from("watchlist").delete().not("dealer_id", "is", null);
}
async function watchCount(dealer: string, auction: string) {
  const { data } = await admin.from("watchlist").select("dealer_id")
    .eq("dealer_id", dealer).eq("auction_id", auction);
  return (data ?? []).length;
}

describe("set_watch", () => {
  beforeEach(clearWatches);

  it("inserts a watch and returns true", async () => {
    const { data, error } = await admin.rpc("set_watch",
      { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(await watchCount(D1, ANCHOR)).toBe(1);
  });

  it("double-watch is idempotent (on conflict do nothing)", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    expect(await watchCount(D1, ANCHOR)).toBe(1);
  });

  it("unwatch deletes the row and returns false", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    const { data } = await admin.rpc("set_watch",
      { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: false });
    expect(data).toBe(false);
    expect(await watchCount(D1, ANCHOR)).toBe(0);
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const { error } = await anon.rpc("set_watch",
      { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discovery_search.test.ts tests/watch_rpc.test.ts`
Expected: all tests PASS (the migration was applied in Step 2). If a test fails, fix the migration SQL and re-run `npx supabase db reset` before re-testing.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0006_discovery.sql tests/discovery_search.test.ts tests/watch_rpc.test.ts
git commit -m "Add search_live_auctions, watchlist table, and set_watch RPC"
```

---

## Task 2: Discovery read module (`src/lib/discovery.ts`)

**Files:**
- Create: `src/lib/discovery.ts`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes: `search_live_auctions` RPC + `watchlist` table (Task 1); `SupabaseClient` from `@supabase/supabase-js`; existing join string style `*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)`.
- Produces:
  - `type AuctionFilters = { q?: string; grades?: string[]; minPrice?: number; maxPrice?: number; region?: string; sort?: string }` — **`minPrice`/`maxPrice` are in CENTS**.
  - `parseFilters(sp: Record<string, string | string[] | undefined>): AuctionFilters` — validates + drops garbage; converts dollar `?min`/`?max` → cents.
  - `searchLiveAuctions(sb, filters): Promise<any[]>` — RPC for ordered ids, re-fetch with joins, **re-sort in TS to match the RPC order**.
  - `getWatchedAuctionIds(sb, dealerId): Promise<string[]>`.
  - `getMyWatching(sb, dealerId): Promise<any[]>` — watched auctions joined to `vehicle`, newest watch first.
  - `REGIONS: string[]`, `SORT_OPTIONS: { value: string; label: string }[]` (shared with the UI).

- [ ] **Step 1: Write the failing tests**

Create `tests/discovery.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb } from "./helpers/db";
import {
  parseFilters, searchLiveAuctions, getWatchedAuctionIds, getMyWatching,
} from "../src/lib/discovery";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const A01 = "a0000000-0000-0000-0000-000000000a01"; // Corolla, D1
const A02 = "a0000000-0000-0000-0000-000000000a02"; // CX-5, D2

async function clearWatches() {
  await admin.from("watchlist").delete().not("dealer_id", "is", null);
}

describe("parseFilters", () => {
  it("keeps valid params and converts dollar prices to cents", () => {
    const f = parseFilters({ q: "corolla", grade: "A,B", min: "10000", max: "13000",
      region: "Auckland", sort: "price_asc" });
    expect(f).toEqual({ q: "corolla", grades: ["A", "B"], minPrice: 1000000,
      maxPrice: 1300000, region: "Auckland", sort: "price_asc" });
  });

  it("drops garbage (bad grades, non-numeric prices, unknown sort/region, blanks)", () => {
    const f = parseFilters({ q: "  ", grade: "Z,,A", min: "abc", max: "-5",
      region: "Narnia", sort: "chaos" });
    expect(f).toEqual({ q: undefined, grades: ["A"], minPrice: undefined,
      maxPrice: undefined, region: undefined, sort: undefined });
  });

  it("handles array-valued params by taking the first", () => {
    expect(parseFilters({ q: ["hi", "there"] }).q).toBe("hi");
  });
});

describe("discovery reads", () => {
  beforeEach(async () => { await resetDb(); await clearWatches(); });

  it("searchLiveAuctions returns joined rows in the RPC's sort order", async () => {
    const rows = await searchLiveAuctions(admin, { sort: "price_asc" });
    // joins present
    expect(rows[0].vehicle).toBeTruthy();
    expect(rows[0].seller).toBeTruthy();
    // order preserved (ascending current price)
    const prices = rows.map((r: any) => r.current_bid ?? r.starting_price);
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
  });

  it("searchLiveAuctions applies filters", async () => {
    const rows = await searchLiveAuctions(admin, { q: "corolla" });
    expect(rows.map((r: any) => r.id)).toEqual([A01]);
  });

  it("getWatchedAuctionIds is dealer-scoped", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: A02, p_watched: true });
    expect(await getWatchedAuctionIds(admin, D1)).toEqual([A02]);
    expect(await getWatchedAuctionIds(admin, D2)).toEqual([]);
  });

  it("getMyWatching returns the dealer's watched auctions with vehicle", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: A02, p_watched: true });
    const rows = await getMyWatching(admin, D1);
    expect(rows.map((r: any) => r.id)).toEqual([A02]);
    expect(rows[0].vehicle.make).toBe("Mazda");
    expect(await getMyWatching(admin, D2)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/lib/discovery` (module not yet created).

- [ ] **Step 3: Implement the module**

Create `src/lib/discovery.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

const AUCTION_WITH_JOINS =
  "*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)";

export const REGIONS = ["Auckland", "Hamilton", "Wellington", "Christchurch", "Tauranga"];
export const SORT_OPTIONS = [
  { value: "ending_soon", label: "Ending soon" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "newest", label: "Newest" },
];

const VALID_GRADES = ["A", "B", "C", "D", "E"];
const VALID_SORTS = SORT_OPTIONS.map((s) => s.value);

export type AuctionFilters = {
  q?: string;
  grades?: string[];
  minPrice?: number; // cents
  maxPrice?: number; // cents
  region?: string;
  sort?: string;
};

type SP = Record<string, string | string[] | undefined>;

function firstStr(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
}
function posIntDollars(v: string | string[] | undefined): number | undefined {
  const s = firstStr(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// Parse URL search params into a validated filter object. Garbage is dropped
// (treated as "no filter") so a bad query string never 500s the grid.
export function parseFilters(sp: SP): AuctionFilters {
  const gradeRaw = firstStr(sp.grade);
  const grades = gradeRaw
    ? gradeRaw.split(",").map((g) => g.trim().toUpperCase()).filter((g) => VALID_GRADES.includes(g))
    : undefined;
  const region = firstStr(sp.region);
  const sort = firstStr(sp.sort);
  const minD = posIntDollars(sp.min);
  const maxD = posIntDollars(sp.max);
  return {
    q: firstStr(sp.q),
    grades: grades && grades.length ? grades : undefined,
    minPrice: minD !== undefined ? minD * 100 : undefined,
    maxPrice: maxD !== undefined ? maxD * 100 : undefined,
    region: region && REGIONS.includes(region) ? region : undefined,
    sort: sort && VALID_SORTS.includes(sort) ? sort : undefined,
  };
}

// Search live auctions server-side, then re-fetch with vehicle/seller joins.
// The RPC returns the correct sort order; PostgREST `.in(...)` does NOT preserve
// order, so we re-sort the joined rows to match the RPC's id order.
export async function searchLiveAuctions(sb: SupabaseClient, filters: AuctionFilters) {
  const { data: ordered, error } = await sb.rpc("search_live_auctions", {
    p_q: filters.q ?? null,
    p_grades: filters.grades && filters.grades.length ? filters.grades : null,
    p_min_price: filters.minPrice ?? null,
    p_max_price: filters.maxPrice ?? null,
    p_region: filters.region ?? null,
    p_sort: filters.sort ?? null,
  });
  if (error || !ordered) return [];
  const ids = (ordered as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  const { data: joined } = await sb.from("auctions").select(AUCTION_WITH_JOINS).in("id", ids);
  const byId = new Map((joined ?? []).map((r: { id: string }) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Auction ids the dealer watches (for rendering filled/empty hearts).
export async function getWatchedAuctionIds(sb: SupabaseClient, dealerId: string): Promise<string[]> {
  const { data } = await sb.from("watchlist").select("auction_id").eq("dealer_id", dealerId);
  return (data ?? []).map((r: { auction_id: string }) => r.auction_id);
}

// The dealer's watched auctions joined to vehicle, newest watch first.
export async function getMyWatching(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("watchlist")
    .select("created_at, auction:auctions(*, vehicle:vehicles(*))")
    .eq("dealer_id", dealerId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r: { auction: unknown }) => r.auction).filter(Boolean);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/discovery.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/discovery.ts tests/discovery.test.ts
git commit -m "Add discovery read module with search, watch reads, and filter parsing"
```

---

## Task 3: Watch write path (service + server action)

**Files:**
- Create: `src/lib/watch/service.ts`, `src/lib/watch/actions.ts`
- Test: `tests/watch_service.test.ts`

**Interfaces:**
- Consumes: `set_watch` RPC (Task 1); `serviceClient()` from `@/lib/supabase/service`; `getDealerId()` from `@/lib/session`; `revalidatePath` from `next/cache`; `redirect` from `next/navigation`.
- Produces:
  - `setWatch(dealerId: string, auctionId: string, watched: boolean): Promise<{ ok: boolean; watched?: boolean }>`.
  - `toggleWatchAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }>` (`"use server"`) — reads `dealer_id` cookie (redirect `/login` if absent), reads `auctionId` + `watched` (`"true"`/`"false"`) from the form, calls `setWatch`, `revalidatePath("/")` and `revalidatePath("/dashboard")`.

- [ ] **Step 1: Read the Next.js docs for the action**

Read: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md` and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`.
Purpose: confirm `revalidatePath`/`redirect` usage in this Next version (mirrors `src/app/dashboard/actions.ts`).

- [ ] **Step 2: Write the failing service test**

Create `tests/watch_service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin } from "./helpers/db";
import { setWatch } from "../src/lib/watch/service";

const D1 = "11111111-1111-1111-1111-111111111111";
const ANCHOR = "a0000000-0000-0000-0000-000000000a01";

async function clearWatches() {
  await admin.from("watchlist").delete().not("dealer_id", "is", null);
}
async function watched(dealer: string, auction: string) {
  const { data } = await admin.from("watchlist").select("dealer_id")
    .eq("dealer_id", dealer).eq("auction_id", auction);
  return (data ?? []).length === 1;
}

describe("setWatch service", () => {
  beforeEach(clearWatches);

  it("watches and unwatches via the service-role client", async () => {
    expect(await setWatch(D1, ANCHOR, true)).toEqual({ ok: true, watched: true });
    expect(await watched(D1, ANCHOR)).toBe(true);
    expect(await setWatch(D1, ANCHOR, false)).toEqual({ ok: true, watched: false });
    expect(await watched(D1, ANCHOR)).toBe(false);
  });

  it("watching twice is idempotent", async () => {
    await setWatch(D1, ANCHOR, true);
    await setWatch(D1, ANCHOR, true);
    expect(await watched(D1, ANCHOR)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/watch_service.test.ts`
Expected: FAIL — cannot resolve `../src/lib/watch/service`.

- [ ] **Step 4: Implement the service**

Create `src/lib/watch/service.ts`:

```ts
import { serviceClient } from "@/lib/supabase/service";

// Server-only: writes via the service-role client. NEVER import into a "use client" module.
export async function setWatch(
  dealerId: string,
  auctionId: string,
  watched: boolean
): Promise<{ ok: boolean; watched?: boolean }> {
  const { data, error } = await serviceClient().rpc("set_watch", {
    p_dealer_id: dealerId,
    p_auction_id: auctionId,
    p_watched: watched,
  });
  if (error) return { ok: false };
  return { ok: true, watched: data as boolean };
}
```

- [ ] **Step 5: Implement the server action**

Create `src/lib/watch/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { setWatch } from "@/lib/watch/service";

export async function toggleWatchAction(
  _prev: { error?: string },
  formData: FormData
): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const watched = String(formData.get("watched")) === "true";
  const r = await setWatch(dealerId, auctionId, watched);
  if (!r.ok) return { error: "Could not update your watchlist, try again." };
  revalidatePath("/");
  revalidatePath("/dashboard");
  return {};
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/watch_service.test.ts`
Expected: all PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/watch/service.ts src/lib/watch/actions.ts tests/watch_service.test.ts
git commit -m "Add watch write path: setWatch service and toggleWatchAction"
```

---

## Task 4: Filtering UI (FilterBar + home grid)

**Files:**
- Create: `src/components/FilterBar.tsx`
- Modify: `src/app/page.tsx`, `src/lib/auctions.ts`

**Interfaces:**
- Consumes: `parseFilters`, `searchLiveAuctions`, `REGIONS`, `SORT_OPTIONS` (Task 2); `serverClient()`; `getDealerId()`; `AuctionCard`; `Header`.
- Produces: `FilterBar` client component that reads/writes URL search params (`?q=&grade=A,B&min=&max=&region=&sort=`); `min`/`max` are **whole dollars**. Home page becomes an async server component parsing `searchParams` (a Promise). Empty state: "No auctions match your filters." (Watched membership is added in Task 5.)

- [ ] **Step 1: Read the Next.js docs for searchParams**

Read: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` (the `searchParams` section — it is a `Promise<{ [key: string]: string | string[] | undefined }>` you must `await`) and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` (client-side reads).

- [ ] **Step 2: Implement the FilterBar**

Create `src/components/FilterBar.tsx`:

```tsx
"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { REGIONS, SORT_OPTIONS } from "@/lib/discovery";

const GRADES = ["A", "B", "C", "D", "E"];
const inputClass =
  "rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100";

export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [q, setQ] = useState(params.get("q") ?? "");
  const grades = (params.get("grade") ?? "").split(",").filter(Boolean);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Debounce the text search → ?q=. Skip the first run (initial mount).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setParam("q", q.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function toggleGrade(g: string) {
    const next = grades.includes(g) ? grades.filter((x) => x !== g) : [...grades, g];
    setParam("grade", next.join(","));
  }

  function clearAll() {
    setQ("");
    router.replace(pathname, { scroll: false });
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <input
        type="search"
        placeholder="Search make, model, variant"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={`${inputClass} w-56`}
      />

      <div className="flex items-center gap-1">
        {GRADES.map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={grades.includes(g)}
            onClick={() => toggleGrade(g)}
            className={`rounded px-2 py-1 text-sm ${
              grades.includes(g)
                ? "bg-emerald-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <input
        type="number"
        min="0"
        placeholder="Min $"
        defaultValue={params.get("min") ?? ""}
        onChange={(e) => setParam("min", e.target.value)}
        className={`${inputClass} w-24`}
      />
      <input
        type="number"
        min="0"
        placeholder="Max $"
        defaultValue={params.get("max") ?? ""}
        onChange={(e) => setParam("max", e.target.value)}
        className={`${inputClass} w-24`}
      />

      <select
        value={params.get("region") ?? ""}
        onChange={(e) => setParam("region", e.target.value)}
        className={inputClass}
      >
        <option value="">All regions</option>
        {REGIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      <select
        value={params.get("sort") ?? "ending_soon"}
        onChange={(e) => setParam("sort", e.target.value === "ending_soon" ? "" : e.target.value)}
        className={inputClass}
      >
        {SORT_OPTIONS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={clearAll}
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
        Clear
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite the home page to filter server-side**

Replace the entire contents of `src/app/page.tsx`:

```tsx
import { getDealerId } from "@/lib/session";
import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { searchLiveAuctions, parseFilters } from "@/lib/discovery";
import { AuctionCard } from "@/components/AuctionCard";
import { FilterBar } from "@/components/FilterBar";
import { Header } from "@/components/Header";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await getDealerId())) redirect("/login");

  const filters = parseFilters(await searchParams);
  const sb = await serverClient();
  const auctions = await searchLiveAuctions(sb, filters);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Header />
      <h1 className="text-2xl font-semibold mb-6">Live auctions</h1>
      <FilterBar />
      {auctions.length === 0 ? (
        <p className="text-zinc-400">No auctions match your filters.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {auctions.map((a) => (
            <AuctionCard
              key={a.id}
              auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
            />
          ))}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Remove the now-dead `getLiveAuctions`**

`getLiveAuctions` was only ever called by the home page, which now uses `searchLiveAuctions`. Delete it from `src/lib/auctions.ts` (leave `getAuctionById`, still used by the auction detail page). Remove exactly this function:

```ts
export async function getLiveAuctions() {
  const sb = await serverClient();
  const { data } = await sb.from("auctions")
    .select("*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)")
    .eq("status", "live").order("end_time", { ascending: true });
  return data ?? [];
}
```

Verify nothing else references it:

Run: `git grep -n "getLiveAuctions" -- src tests`
Expected: no matches.

- [ ] **Step 5: Verify it builds and typechecks**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 6: Manual smoke check**

Run: `npm run dev`, open `http://localhost:3000` (log in first), and confirm: the grid shows live auctions; typing "corolla" narrows to one card; the grade buttons, price inputs, region and sort selects change the URL and the grid; "Clear" resets. Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add src/components/FilterBar.tsx src/app/page.tsx src/lib/auctions.ts
git commit -m "Add FilterBar and drive the home grid from URL search params"
```

---

## Task 5: Watch UI (button on cards, detail, dashboard)

**Files:**
- Create: `src/components/WatchButton.tsx`
- Modify: `src/components/AuctionCard.tsx`, `src/app/page.tsx`, `src/app/auction/[id]/page.tsx`, `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `toggleWatchAction` (Task 3); `getWatchedAuctionIds`, `getMyWatching` (Task 2); existing `DashboardSection`, `formatNZD`, join helpers.
- Produces: `WatchButton({ auctionId, watched })` client component (heart toggle, submits `toggleWatchAction` with the *target* state). `AuctionCard` gains an optional `watched?: boolean` prop and hosts the button as an overlay sibling of its `Link` (never nested inside the anchor). The home grid, auction detail page (live only), and a 5th dashboard "Watching" section all render watch state.

- [ ] **Step 1: Implement the WatchButton**

Create `src/components/WatchButton.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { toggleWatchAction } from "@/lib/watch/actions";

export function WatchButton({ auctionId, watched }: { auctionId: string; watched: boolean }) {
  const [state, action, pending] = useActionState(toggleWatchAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="auctionId" value={auctionId} />
      {/* carry the TARGET state: clicking flips current → opposite */}
      <input type="hidden" name="watched" value={watched ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        aria-pressed={watched}
        aria-label={watched ? "Unwatch" : "Watch"}
        title={watched ? "Unwatch" : "Watch"}
        className={`rounded-full bg-zinc-900/80 px-2 py-1 text-base leading-none disabled:opacity-50 ${
          watched ? "text-red-400" : "text-zinc-300 hover:text-red-300"
        }`}
      >
        {watched ? "♥" : "♡"}
      </button>
      {state.error && <span className="sr-only">{state.error}</span>}
    </form>
  );
}
```

- [ ] **Step 2: Restructure AuctionCard to host the button**

Replace the entire contents of `src/components/AuctionCard.tsx` (the button must be a sibling of the `Link`, not nested inside it — a `<button>` inside an `<a>` is invalid HTML):

```tsx
import Link from "next/link";
import { Auction, Vehicle, Dealer } from "@/types/db";
import { formatNZD } from "@/lib/money";
import { CountdownTimer } from "./CountdownTimer";
import { DealerBadge } from "./DealerBadge";
import { WatchButton } from "./WatchButton";

type AuctionWithJoins = Auction & {
  vehicle: Vehicle;
  seller: Dealer;
};

export function AuctionCard({
  auction,
  watched = false,
}: {
  auction: AuctionWithJoins;
  watched?: boolean;
}) {
  const { vehicle, seller } = auction;
  const displayPrice = auction.current_bid ?? auction.starting_price;
  const photoUrl = vehicle.photo_urls?.[0] ?? null;

  return (
    <div className="group relative">
      <div className="absolute top-2 left-2 z-10">
        <WatchButton auctionId={auction.id} watched={watched} />
      </div>

      <Link
        href={`/auction/${auction.id}`}
        className="flex flex-col rounded-xl bg-zinc-800 overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors"
      >
        <div className="relative h-44 bg-zinc-700 flex items-center justify-center">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-zinc-500 text-sm">No photo</span>
          )}
          <span className="absolute top-2 right-2 rounded bg-zinc-900/80 px-2 py-0.5 text-xs font-semibold text-zinc-200">
            Grade {vehicle.grade}
          </span>
        </div>

        <div className="flex flex-col gap-2 p-4">
          <h2 className="text-base font-semibold text-zinc-100 leading-tight">
            {vehicle.year} {vehicle.make} {vehicle.model}
            {vehicle.variant ? <span className="font-normal text-zinc-400"> {vehicle.variant}</span> : null}
          </h2>
          <p className="text-xs text-zinc-400">
            {vehicle.odometer_km.toLocaleString("en-NZ")} km
            {vehicle.color ? ` · ${vehicle.color}` : ""}
          </p>

          <div className="flex items-center justify-between mt-1">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                {auction.current_bid ? "Current bid" : "Starting price"}
              </p>
              <p className="text-lg font-bold text-white">{formatNZD(displayPrice)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">Ends in</p>
              <CountdownTimer endTime={auction.end_time} />
            </div>
          </div>

          <div className="mt-2">
            <DealerBadge dealer={seller} />
          </div>
        </div>
      </Link>
    </div>
  );
}
```

- [ ] **Step 3: Pass watched membership from the home grid**

Edit `src/app/page.tsx`. Update the discovery import and add the watched-ids fetch + prop.

Change the import line:

```tsx
import { searchLiveAuctions, parseFilters } from "@/lib/discovery";
```

to:

```tsx
import { searchLiveAuctions, parseFilters, getWatchedAuctionIds } from "@/lib/discovery";
```

Change the data-fetch block:

```tsx
  if (!(await getDealerId())) redirect("/login");

  const filters = parseFilters(await searchParams);
  const sb = await serverClient();
  const auctions = await searchLiveAuctions(sb, filters);
```

to:

```tsx
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");

  const filters = parseFilters(await searchParams);
  const sb = await serverClient();
  const [auctions, watchedIds] = await Promise.all([
    searchLiveAuctions(sb, filters),
    getWatchedAuctionIds(sb, dealerId),
  ]);
  const watched = new Set(watchedIds);
```

Change the card render:

```tsx
            <AuctionCard
              key={a.id}
              auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
            />
```

to:

```tsx
            <AuctionCard
              key={a.id}
              auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
              watched={watched.has(a.id)}
            />
```

- [ ] **Step 4: Add the WatchButton to the auction detail page (live only)**

Edit `src/app/auction/[id]/page.tsx`.

Add the imports near the top (after the existing imports):

```tsx
import { getWatchedAuctionIds } from "@/lib/discovery";
import { WatchButton } from "@/components/WatchButton";
```

After the `bids` block (just before `const { vehicle, seller } = auction;`), compute the watched state for live auctions:

```tsx
  // Watch state for live auctions (drafts are not watchable).
  let isWatched = false;
  if (!isDraft) {
    const sbWatch = await serverClient();
    isWatched = (await getWatchedAuctionIds(sbWatch, currentDealerId)).includes(id);
  }
```

In the vehicle title block, wrap the `<h1>` so the button sits beside it. Replace:

```tsx
          <div>
            <h1 className="text-2xl font-bold text-white leading-tight">
              {vehicle.year} {vehicle.make} {vehicle.model}
              {vehicle.variant ? (
                <span className="font-normal text-zinc-400"> {vehicle.variant}</span>
              ) : null}
            </h1>
```

with:

```tsx
          <div>
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-2xl font-bold text-white leading-tight">
                {vehicle.year} {vehicle.make} {vehicle.model}
                {vehicle.variant ? (
                  <span className="font-normal text-zinc-400"> {vehicle.variant}</span>
                ) : null}
              </h1>
              {!isDraft && <WatchButton auctionId={auction.id} watched={isWatched} />}
            </div>
```

(The extra `<div>` is closed by the existing `</div>` that already wraps this title block — verify the JSX still balances after the edit via the typecheck in Step 6.)

- [ ] **Step 5: Add the "Watching" section to the dashboard**

Edit `src/app/dashboard/page.tsx`.

Add to the dashboard imports:

```tsx
import { getMyWatching } from "@/lib/discovery";
```

Add `getMyWatching` to the parallel fetch. Replace:

```tsx
  const [listings, bidding, wins, sales] = await Promise.all([
    getMyListings(sb, dealerId),
    getMyBiddingAuctions(sb, dealerId),
    getMyWins(sb, dealerId),
    getMySales(sb, dealerId),
  ]);
```

with:

```tsx
  const [listings, bidding, wins, sales, watching] = await Promise.all([
    getMyListings(sb, dealerId),
    getMyBiddingAuctions(sb, dealerId),
    getMyWins(sb, dealerId),
    getMySales(sb, dealerId),
    getMyWatching(sb, dealerId),
  ]);
```

Add the section after the "My sales" `</DashboardSection>` (before the closing `</main>`):

```tsx
        <DashboardSection title="Watching" count={watching.length} empty="You're not watching any auctions.">
          {watching.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="font-mono text-zinc-300">{formatNZD(a.current_bid ?? a.starting_price)}</span>
            </Link>
          ))}
        </DashboardSection>
```

- [ ] **Step 6: Verify it builds and typechecks**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed. If the detail-page JSX is unbalanced, `build` will report it — fix the tag nesting.

- [ ] **Step 7: Verify the service client did not leak into a client module**

Run: `git grep -n "lib/supabase/service\|lib/watch/service" src/components src/app`
Expected: no match inside any file that begins with `"use client"`. `WatchButton.tsx` must import only `@/lib/watch/actions` (the `"use server"` action), never the service. (`toggleWatchAction`/its service import live in server modules.)

- [ ] **Step 8: Commit**

```bash
git add src/components/WatchButton.tsx src/components/AuctionCard.tsx src/app/page.tsx src/app/auction/[id]/page.tsx src/app/dashboard/page.tsx
git commit -m "Add watch toggle to cards, auction detail, and a dashboard Watching section"
```

---

## Task 6: End-to-end test + full suite green

**Files:**
- Create: `tests/e2e/discovery.spec.ts`

**Interfaces:**
- Consumes: the full running app (Playwright `webServer` runs `npm run dev`); `global-setup.ts` resets the DB to seed before the run; seeded live auctions (Mazda CX-5 = `a02`, Toyota Corolla = `a01`); login page with per-dealer buttons.
- Produces: an e2e spec exercising search → narrow → watch → dashboard → unwatch. No R2 involved, so it runs (not skipped).

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/discovery.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("dealer can search, watch, and manage their watchlist", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click();
  await expect(page).toHaveURL("/");

  // Search narrows the grid to the single matching live auction (Mazda CX-5),
  // and the non-matching Toyota Corolla card disappears.
  await page.getByPlaceholder("Search make, model, variant").fill("Mazda");
  await expect(page.getByRole("heading", { name: /Mazda CX-5/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Toyota Corolla/ })).toHaveCount(0);

  // Watch it from the card; the button flips to Unwatch.
  await page.getByRole("button", { name: "Watch" }).click();
  await expect(page.getByRole("button", { name: "Unwatch" })).toBeVisible();

  // It shows up under "Watching" on the dashboard.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");
  await expect(page.getByText("2020 Mazda CX-5")).toBeVisible();

  // Open the auction from the Watching row and unwatch it.
  await page.getByText("2020 Mazda CX-5").click();
  await expect(page).toHaveURL(/\/auction\//);
  await page.getByRole("button", { name: "Unwatch" }).click();
  await expect(page.getByRole("button", { name: "Watch" })).toBeVisible();

  // Back on the dashboard, "Watching" is empty again.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("2020 Mazda CX-5")).toHaveCount(0);
  await expect(page.getByText("You're not watching any auctions.")).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `npx playwright test tests/e2e/discovery.spec.ts`
Expected: PASS. (The `globalSetup` resets the DB first. If the dev server isn't already running, Playwright starts it.) If the watch button doesn't flip, confirm `revalidatePath("/")` runs in `toggleWatchAction` and the `WatchButton` `aria-label` toggles on `watched`.

- [ ] **Step 3: Run the full integration suite (sequential, shared DB)**

Run: `npx supabase db reset && npm test`
Expected: all Vitest files PASS (Slices 1–4). `fileParallelism: false` keeps them deterministic. If any Slice 1–3 test regressed, investigate before proceeding.

- [ ] **Step 4: Run the full e2e suite**

Run: `npx playwright test`
Expected: all e2e specs PASS (dashboard + discovery; any R2-gated specs remain skipped).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/discovery.spec.ts
git commit -m "Add discovery e2e covering search, watch, and dashboard watching"
```

---

## Self-Review

**Spec coverage (§ of `2026-07-04-slice4-discovery-design.md`):**
- §4 `search_live_auctions` (setof auctions, live-only, all filters, sorts, anon EXECUTE) → Task 1. ✅
- §4 `watchlist` table (FK cascade, anon SELECT, no anon write) → Task 1. ✅
- §4 `set_watch` (service_role only, on-conflict, returns state) → Task 1. ✅
- §5 `AuctionFilters`, `searchLiveAuctions` (RPC → ordered ids → join → TS re-sort), `getWatchedAuctionIds`, `getMyWatching` → Task 2. ✅
- §6 `setWatch` service + `toggleWatchAction` (cookie identity, revalidate) → Task 3. ✅
- §7 `FilterBar` (URL params), home grid empty state, region list → Task 4. ✅
- §7 `WatchButton` on cards + detail (live only), `AuctionCard` `watched` prop, dashboard "Watching" section → Task 5. ✅
- §8 error handling: garbage params dropped (`parseFilters` unit test), reads return `[]` on error, action redirects without cookie → Tasks 2, 3. ✅
- §9 integration (search filters/sort/live-only; set_watch idempotent + anon-denied; dealer scoping) + e2e → Tasks 1, 2, 3, 6. ✅
- §9 invariant (anon cannot execute `set_watch`; search never returns non-live) → Tasks 1. ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `AuctionFilters` (cents) defined in Task 2 and consumed identically in Tasks 3–4; `setWatch`/`toggleWatchAction`/`WatchButton` signatures match across Tasks 3 and 5; `getWatchedAuctionIds`/`getMyWatching` signatures match across Tasks 2 and 5; RPC param names (`p_q`, `p_grades`, `p_min_price`, `p_max_price`, `p_region`, `p_sort`, `p_dealer_id`, `p_auction_id`, `p_watched`) match between Task 1 SQL and Tasks 2–3 callers. ✅

**Money-unit consistency:** the DB/service/`AuctionFilters` layer is cents; `?min`/`?max` and the `FilterBar` inputs are dollars; `parseFilters` is the sole dollars→cents conversion (×100). Task 1 tests use cents directly; Task 2 `parseFilters` test asserts the ×100 conversion. ✅
