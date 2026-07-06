# Slice 9 — Dealer Profiles & Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/dealer/[id]` profile page that surfaces a seller's trust signals (verified, rating, region, license) and track record (live listings + completed sales), reachable by clicking the seller on an auction detail page.

**Architecture:** Pure read/UI slice — no migration. `src/lib/dealers.ts` adds three DI reads over the existing anon-readable `dealers`/`auctions`/`vehicles`/`settlements` tables; a `/dealer/[id]` server component renders a trust header + a live-listings grid (reusing `AuctionCard`) + a sales-history list; the auction-detail seller `DealerBadge` gains a `Link` wrapper.

**Tech Stack:** Next.js 16 (App Router, RSC server components), Supabase local (Postgres + PostgREST), TypeScript, Vitest (integration vs local DB), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-06-slice9-dealer-profiles-design.md`
**Branch:** `feat/slice9-dealer-profiles` (already created; design committed at `1e96af3`).

## Global Constraints

- **No migration.** All fields (`rating`, `is_verified`, `region`, `dealer_license_no`, `initials`, `business_name`) and tables already exist. Reads go through `serverClient()` (anon already has SELECT on `dealers`/`auctions`/`vehicles`/`settlements`). No new RPC/grant/table/column.
- **DI pattern:** every read is `(sb: SupabaseClient, id: string)` — pages pass `await serverClient()`, tests pass `admin`. Mirrors `src/lib/dashboard.ts`/`discovery.ts`.
- **Access:** the page is login-required (`getDealerId()` → `redirect("/login")`); any logged-in dealer may view any dealer. Unknown id → `notFound()`.
- **Data rules:** live listings = `status='live' AND end_time > now()` (excludes drafts, sold/passed, expired-unswept), ending-soonest first. Sales history = `status='sold'` only (no `passed`), most-recent (`end_time` desc) first. `settlement` from the embed may be an array — read `Array.isArray(s) ? s[0] : s` (as `dashboard/page.tsx` does).
- **Rating:** surface the existing static `dealers.rating`, one decimal. Use `Number(dealer.rating).toFixed(1)` defensively (PostgREST may serialize `numeric` as a string).
- **Entry point:** wrap the seller `DealerBadge` on the **auction detail page** in a `Link` to `/dealer/[seller.id]`. Do NOT modify `DealerBadge`, and do NOT link the badge inside `AuctionCard` (the card is already an `<a>` — nested anchors are invalid HTML). Reuse `AuctionCard` and `DealerBadge` as-is.
- **Next.js 16:** `params` is a Promise — `await` it. Before writing the page, skim the App Router page guide under `node_modules/next/dist/docs/` (AGENTS.md: "This is NOT the Next.js you know"); `redirect`/`notFound` from `next/navigation`.
- **Money:** integer cents; `formatNZD` from `src/lib/money.ts`.
- **Vitest:** shared single local DB, `fileParallelism: false`. New tests reset/clean own state (`beforeEach(resetDb)`, `afterEach(deleteAuctions(...))`) and scope assertions to seeded/fixture ids (use non-exact `contains`/`every` checks, not exact grid counts, to stay robust to any leaked fixture).
- **Playwright:** `workers: 1`; FRESH dev server per full run; `listing.spec.ts` stays skipped (R2).
- **Commits:** single line, no co-author trailer. Work only on `feat/slice9-dealer-profiles` (never `main`).
- **No credentials:** this slice adds none.

## File Structure

- **Create** `src/lib/dealers.ts` — `getDealer`, `getDealerLiveListings`, `getDealerSales`.
- **Create** `src/app/dealer/[id]/page.tsx` — the profile page (trust header + live listings + sales history).
- **Modify** `src/app/auction/[id]/page.tsx` — wrap the seller `DealerBadge` in a `Link`.
- **Create tests:** `tests/dealers.test.ts` (Task 1), `tests/e2e/dealer-profile.spec.ts` (Task 3).

**Seed ids referenced (`supabase/seed.sql`):** dealers D1 `11111111-1111-1111-1111-111111111111` (Auckland Motor Wholesale, rating 4.8, verified), D2 `22222222-2222-2222-2222-222222222222` (Waikato Trade Cars), D3 `33333333-3333-3333-3333-333333333333`. Auctions a01 `a0000000-0000-0000-0000-000000000a01` (Toyota Corolla, seller D1, live), a06 `a0000000-0000-0000-0000-000000000a06` (Toyota Hilux, seller D1, live), draft `a0000000-0000-0000-0000-0000000000d1` (Nissan Navara, seller D1, draft). `createLiveAuction(seller)` → Kia Sportage: starting 1,000,000 / reserve 1,200,000 / buy_now 1,500,000.

---

### Task 1: `src/lib/dealers.ts` read functions

**Files:**
- Create: `src/lib/dealers.ts`
- Test: `tests/dealers.test.ts`

**Interfaces:**
- Consumes: `Dealer` type (`@/types/db`); `place_bid`/`close_auction`/`test_set_end_in_seconds` RPCs and `createLiveAuction`/`deleteAuctions`/`resetDb`/`admin` (tests).
- Produces:
  - `getDealer(sb, id): Promise<Dealer | null>`
  - `getDealerLiveListings(sb, id): Promise<any[]>` — `status='live'`, `end_time > now`, ending-soonest first, each with `vehicle` + `seller` embedded (for `AuctionCard`).
  - `getDealerSales(sb, id): Promise<any[]>` — `status='sold'`, most-recent first, each with `vehicle` + `settlement` embedded.

- [ ] **Step 1: Write the failing test**

Create `tests/dealers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { getDealer, getDealerLiveListings, getDealerSales } from "@/lib/dealers";

const D1 = "11111111-1111-1111-1111-111111111111"; // Auckland Motor Wholesale
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333";
const A01 = "a0000000-0000-0000-0000-000000000a01"; // Corolla, seller D1, live
const A06 = "a0000000-0000-0000-0000-000000000a06"; // Hilux, seller D1, live
const DRAFT_D1 = "a0000000-0000-0000-0000-0000000000d1"; // Navara, seller D1, DRAFT

const created: string[] = [];

describe("dealer profile reads", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("getDealer returns the row for a known id and null for an unknown id", async () => {
    const d = await getDealer(admin, D1);
    expect(d).not.toBeNull();
    expect(d!.business_name).toBe("Auckland Motor Wholesale");
    expect(Number(d!.rating)).toBe(4.8);
    expect(d!.is_verified).toBe(true);
    expect(await getDealer(admin, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getDealerLiveListings returns only the dealer's live, future auctions (not drafts, not other dealers)", async () => {
    const rows = await getDealerLiveListings(admin, D1);
    const ids = rows.map((a) => a.id);
    expect(ids).toContain(A01);
    expect(ids).toContain(A06);
    expect(ids).not.toContain(DRAFT_D1); // draft excluded
    expect(rows.every((a) => a.seller_dealer_id === D1 && a.status === "live")).toBe(true);
    expect(rows[0].vehicle).toBeTruthy(); // vehicle embedded for AuctionCard
  });

  it("getDealerSales returns only the dealer's sold auctions with their settlement", async () => {
    // Build a completed sale for D1: create → push above reserve → expire → close.
    const id = await createLiveAuction(D1); created.push(id);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1300000 }); // D2 leads
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D3, p_max_amount: 1250000 }); // proxy holds → price 1,275,000
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const { data: closed } = await admin.rpc("close_auction", { p_auction_id: id });
    expect(closed).toBe("sold");

    const sales = await getDealerSales(admin, D1);
    const sale = sales.find((s) => s.id === id);
    expect(sale).toBeTruthy();
    const settlement = Array.isArray(sale.settlement) ? sale.settlement[0] : sale.settlement;
    expect(settlement.sale_price).toBe(1275000);
    expect(sales.every((s) => s.status === "sold")).toBe(true);
    expect(sales.map((s) => s.id)).not.toContain(A01); // a live auction is not a sale
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dealers.test.ts`
Expected: FAIL — `@/lib/dealers` does not exist.

- [ ] **Step 3: Write the library**

Create `src/lib/dealers.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Dealer } from "@/types/db";

const AUCTION_WITH_JOINS =
  "*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)";

// The dealer row for a profile, or null if the id is unknown (page → notFound()).
export async function getDealer(sb: SupabaseClient, id: string): Promise<Dealer | null> {
  const { data } = await sb.from("dealers").select("*").eq("id", id).maybeSingle();
  return (data as Dealer) ?? null;
}

// A dealer's currently-live listings (status='live', not yet ended), ending soonest first.
// The seller join lets the profile page reuse AuctionCard.
export async function getDealerLiveListings(sb: SupabaseClient, id: string): Promise<any[]> {
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_JOINS)
    .eq("seller_dealer_id", id)
    .eq("status", "live")
    .gt("end_time", new Date().toISOString())
    .order("end_time", { ascending: true });
  return data ?? [];
}

// A dealer's completed sales (status='sold') with the settlement, most recent first.
export async function getDealerSales(sb: SupabaseClient, id: string): Promise<any[]> {
  const { data } = await sb
    .from("auctions")
    .select("*, vehicle:vehicles(*), settlement:settlements(*)")
    .eq("seller_dealer_id", id)
    .eq("status", "sold")
    .order("end_time", { ascending: false });
  return data ?? [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dealers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dealers.ts tests/dealers.test.ts
git commit -m "Add dealer profile reads (dealer row, live listings, completed sales)"
```

---

### Task 2: `/dealer/[id]` profile page + auction-detail seller link

**Files:**
- Create: `src/app/dealer/[id]/page.tsx`
- Modify: `src/app/auction/[id]/page.tsx` (wrap the seller `DealerBadge` in a `Link`)

**Interfaces:**
- Consumes: `getDealer`, `getDealerLiveListings`, `getDealerSales` (Task 1); `getWatchedAuctionIds` (`@/lib/discovery`); `getDealerId`, `serverClient`, `formatNZD`, `Header`, `AuctionCard`.
- Produces: the `/dealer/[id]` route; the auction-detail seller badge now links to it.

- [ ] **Step 1: Read the Next.js page guide**

Before writing the route, skim the App Router page/rendering guide under `node_modules/next/dist/docs/` (async server components, `await params`, dynamic rendering via `cookies()`). Confirm the structure matches `src/app/dashboard/page.tsx`.

- [ ] **Step 2: Create the profile page**

Create `src/app/dealer/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { AuctionCard } from "@/components/AuctionCard";
import { getWatchedAuctionIds } from "@/lib/discovery";
import { getDealer, getDealerLiveListings, getDealerSales } from "@/lib/dealers";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}
function soldDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

export default async function DealerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const viewerId = await getDealerId();
  if (!viewerId) redirect("/login");
  const { id } = await params;

  const sb = await serverClient();
  const dealer = await getDealer(sb, id);
  if (!dealer) notFound();

  const [listings, sales, watchedIds] = await Promise.all([
    getDealerLiveListings(sb, id),
    getDealerSales(sb, id),
    getWatchedAuctionIds(sb, viewerId),
  ]);
  const watched = new Set(watchedIds);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-6 py-8 space-y-8">
        {/* Trust header */}
        <section className="flex items-start gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-zinc-600 text-lg font-bold uppercase text-white">
            {dealer.initials}
          </span>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-white">{dealer.business_name}</h1>
              {dealer.is_verified && <span className="text-blue-400" title="Verified">✓</span>}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-400">
              <span className="text-amber-400">★ {Number(dealer.rating).toFixed(1)}</span>
              <span>{dealer.region}</span>
              <span>Licence {dealer.dealer_license_no}</span>
            </div>
            <p className="text-sm text-zinc-300">
              {sales.length} completed {sales.length === 1 ? "sale" : "sales"}
            </p>
          </div>
        </section>

        {/* Live listings */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Live listings</h2>
          {listings.length === 0 ? (
            <p className="text-zinc-400">No live listings right now.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {listings.map((a) => (
                <AuctionCard
                  key={a.id}
                  auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
                  watched={watched.has(a.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Sales history */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Sales history</h2>
          {sales.length === 0 ? (
            <p className="text-zinc-400">No completed sales yet.</p>
          ) : (
            <div className="space-y-2">
              {sales.map((a) => {
                const s = Array.isArray(a.settlement) ? a.settlement[0] : a.settlement;
                return (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-4 py-3"
                  >
                    <span className="text-white">{vehicleLabel(a.vehicle)}</span>
                    <span className="flex items-center gap-4 text-sm">
                      <span className="text-zinc-500">{soldDate(a.end_time)}</span>
                      <span className="font-mono text-emerald-400">{s ? formatNZD(s.sale_price) : "—"}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 3: Wire the seller link on the auction detail page**

Edit `src/app/auction/[id]/page.tsx`. Add the `Link` import at the top (the file does not currently import it):

```ts
import Link from "next/link";
```

Then change the Seller section. Replace:

```tsx
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2 font-semibold">
              Seller
            </h3>
            <DealerBadge dealer={seller} />
```

with:

```tsx
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2 font-semibold">
              Seller
            </h3>
            <Link href={`/dealer/${seller.id}`} className="inline-block hover:opacity-80 transition-opacity">
              <DealerBadge dealer={seller} />
            </Link>
```

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; `/dealer/[id]` compiles (dynamic route).

- [ ] **Step 5: Commit**

```bash
git add src/app/dealer/[id]/page.tsx src/app/auction/[id]/page.tsx
git commit -m "Add dealer profile page and link the auction-detail seller badge to it"
```

---

### Task 3: e2e dealer profile + full green

**Files:**
- Create: `tests/e2e/dealer-profile.spec.ts`

**Interfaces:**
- Consumes: the running app + a fresh DB (Playwright `globalSetup` resets once). Read-only — mutates no auction state, so the spec is order-independent.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/dealer-profile.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// A buyer (Waikato Trade Cars / D2) opens the seeded anchor auction a01 (Toyota Corolla,
// seller = Auckland Motor Wholesale / D1), clicks the seller to reach their profile, and
// verifies the trust header + a live listing. Read-only — mutates no auction state, so this
// spec is order-independent.
const A01 = "/auction/a0000000-0000-0000-0000-000000000a01";

test("a buyer opens a seller's profile from an auction and sees their trust info and listings", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Waikato Trade Cars/ }).click(); // a non-seller viewer
  await expect(page).toHaveURL("/");

  await page.goto(A01);
  // Let the auction page's background Link prefetch settle before clicking (Next dev race guard).
  await page.waitForLoadState("networkidle");
  // The seller badge in the Seller section links to /dealer/[id].
  await page.getByRole("link", { name: /Auckland Motor Wholesale/ }).click();
  // First hit to /dealer/[id] is a cold Turbopack compile in dev — allow extra time.
  await expect(page).toHaveURL(/\/dealer\//, { timeout: 20000 });

  // Trust header: business name heading + verified indicator.
  await expect(page.getByRole("heading", { name: "Auckland Motor Wholesale" })).toBeVisible({ timeout: 20000 });
  // Live listings: the dealer's seeded Corolla appears as a card.
  await expect(page.getByRole("heading", { name: /Toyota Corolla/ })).toBeVisible();
});
```

- [ ] **Step 2: Run the full vitest suite (clean DB) — everything green**

Run: `npx supabase db reset && npm test`
Expected: all test files pass, including `tests/dealers.test.ts`. Report totals.

- [ ] **Step 3: Run the full Playwright suite against a fresh dev server**

Ensure nothing is bound to port 3000 (bash: `netstat -ano | grep ':3000' | grep LISTENING`; if found, `taskkill //PID <pid> //F`), then run:

Run: `npm run test:e2e`
Expected: all specs pass (`dealer-profile.spec.ts` included), `listing.spec.ts` skipped. Playwright manages a fresh dev server + one `globalSetup` reset. If a spec flakes, note which and re-run once; do not weaken assertions.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dealer-profile.spec.ts
git commit -m "Add e2e covering the dealer profile reached from an auction's seller"
```

---

## Self-Review

**1. Spec coverage:**
- §4 data functions (`getDealer` null-on-unknown, `getDealerLiveListings` live+future+joins, `getDealerSales` sold+settlement) → Task 1. ✓
- §5 page (trust header with name/verified/★rating/region/license/N-sales, live-listings grid via `AuctionCard`, sales-history list with vehicle·price·date, empty states, `notFound`/`redirect`) → Task 2. ✓
- §6 auction-detail seller `Link` wrapper (badge unchanged) → Task 2. ✓
- §8 integration (getDealer known/unknown, live excludes draft/other-dealer, sales sold-only + settlement price) → Task 1; e2e (open a01 → click seller → profile shows name + Corolla) → Task 3. ✓
- §3 no migration, login-required, sold-only, static rating, reuse AuctionCard/DealerBadge → Global Constraints + Tasks. ✓

**2. Placeholder scan:** No TBD/TODO; every code step is complete; the e2e pins a01/D1/D2 with reasoning; the sold-fixture arithmetic is spelled out. ✓

**3. Type consistency:** `getDealer`/`getDealerLiveListings`/`getDealerSales` names + `(sb, id)` signatures match between `src/lib/dealers.ts`, `tests/dealers.test.ts`, and the page. `AUCTION_WITH_JOINS` uses the `auctions_seller_dealer_id_fkey` constraint name exactly as `src/lib/discovery.ts` does. The page reads `dealer.initials`/`business_name`/`is_verified`/`rating`/`region`/`dealer_license_no` — all present on the `Dealer` interface (`src/types/db.ts`). The sold-case arithmetic matches Task 1's fixture: D2 max 1,300,000 (leader at 1,000,000), D3 max 1,250,000 → proxy holds → price `least(1,250,000+25,000, 1,300,000)=1,275,000 ≥` reserve 1,200,000 → `sold`, settlement 1,275,000. `soldDate`/`vehicleLabel` are page-local helpers. ✓
