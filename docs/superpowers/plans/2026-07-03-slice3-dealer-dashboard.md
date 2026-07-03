# Slice 3 — Dealer Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a logged-in dealer a `/dashboard` page summarizing their listings, active bids, wins, and sales, with the ability to discard a draft.

**Architecture:** Four read-query functions (dependency-injected Supabase client, anon read client in the page) over existing tables, rendered by an async server component as four stacked sections. One new write — discarding a draft — goes through a `service_role`-only `SECURITY DEFINER` RPC called from a `"use server"` action, mirroring Slice 2. Snapshot at load; no realtime on this page.

**Tech Stack:** Next.js 16 (App Router, RSC, server actions), TypeScript, Tailwind v4, Supabase (Postgres) local, Vitest, Playwright.

## Global Constraints

- The new `discard_draft_listing` RPC is `SECURITY DEFINER`, `set search_path = public`, and granted EXECUTE to **`service_role` only** — explicitly `revoke`d from `public`, `anon`, `authenticated` (Postgres grants EXECUTE to PUBLIC by default). Reads need no new grants (anon already has SELECT on `auctions`/`bids`/`vehicles`/`dealers`/`settlements`).
- The service-role client (`src/lib/supabase/service.ts`) is server-only — never `NEXT_PUBLIC`, never imported into a `"use client"` module. The dashboard read functions use the anon `serverClient()` in the page.
- Seller/dealer identity always comes from the httpOnly `dealer_id` cookie server-side (`getDealerId()`), never client input.
- All money is integer **cents** (NZD); format with `formatNZD` for display only.
- Auction statuses are exactly `draft`, `live`, `ended`, `sold`, `passed`. Vehicle grades `A`–`E`.
- Dashboard query functions take a `SupabaseClient` parameter (DI) so they are testable in vitest with the `admin` client; the page passes `await serverClient()`.
- This slice adds NO credential-dependent tests (no R2). Commits are a single line, no co-author trailer; work on branch `feat/slice3-dashboard`, never commit to `main`.

---

## File Structure

```
supabase/migrations/0005_discard_draft.sql   # discard_draft_listing RPC + grants
supabase/seed.sql                            # (modify) add one seeded draft (dealer 1)
src/lib/dashboard.ts                          # 4 read queries (DI client)
src/lib/listings/service.ts                   # (modify) add discardDraft
src/app/dashboard/page.tsx                    # the dashboard server component
src/app/dashboard/actions.ts                  # "use server" discardDraftAction
src/components/DashboardSection.tsx           # heading + count + empty state wrapper
src/components/DiscardDraftButton.tsx         # client: confirm + discard action
src/components/Header.tsx                     # (modify) add "Dashboard" link
tests/dashboard.test.ts                       # integration: the 4 queries
tests/dashboard_discard.test.ts               # integration: discard RPC (+ anon-denied)
tests/e2e/dashboard.spec.ts                   # e2e: login → dashboard → discard seeded draft
```

---

### Task 1: Seed a draft + dashboard read queries (TDD)

**Files:**
- Create: `src/lib/dashboard.ts`
- Modify: `supabase/seed.sql`
- Test: `tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient` from `@supabase/supabase-js`; existing tables; test helpers `admin`, `resetDb`, `cleanupDrafts` (`tests/helpers/db.ts`), and RPCs `place_bid`, `close_auction`, `test_set_end_in_seconds`.
- Produces (all take `(sb: SupabaseClient, dealerId: string)`, return `Promise<any[]>`):
  - `getMyListings` — seller's auctions, all statuses, with `vehicle`.
  - `getMyBiddingAuctions` — live auctions the dealer has bid on, with `vehicle`.
  - `getMyWins` — auctions the dealer won (current winner, ended, reserve met), with `vehicle`.
  - `getMySales` — seller's sold/passed auctions, with `vehicle` and `settlement`.

- [ ] **Step 1: Add the seeded draft**

Append to `supabase/seed.sql` (after the last auction block):

```sql
-- ── Draft listing (Slice 3 dashboard: a draft owned by dealer 1) ───────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaad-0000-0000-0000-00000000000d','Nissan','Navara',2022,'ST-X',22000,'A','Slate Grey',
    'As new. Balance of factory warranty.','Fresh trade, immaculate.',
    array['https://media.example-r2.dev/navara-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, start_time, end_time, status, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-0000000000d1', v.id,
  '11111111-1111-1111-1111-111111111111',
  null, now() + interval '3 days', 'draft',
  1500000, 1750000, 2100000
from v;
```

- [ ] **Step 2: Write the failing test**

Create `tests/dashboard.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb, cleanupDrafts } from "./helpers/db";
import { getMyListings, getMyBiddingAuctions, getMyWins, getMySales } from "../src/lib/dashboard";

const ANCHOR = "a0000000-0000-0000-0000-000000000a01"; // live, seller = dealer 1, start 600000, reserve 750000
const D1 = "11111111-1111-1111-1111-111111111111"; // anchor seller
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333";

async function bid(dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", { p_auction_id: ANCHOR, p_dealer_id: dealer, p_max_amount: max });
  if (error) throw error;
}

describe("dashboard queries", () => {
  beforeEach(async () => { await resetDb(); await cleanupDrafts(); });

  it("getMyListings returns the seller's auctions including drafts", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", {
      p_dealer_id: D2, p_make: "Kia", p_model: "Sportage", p_year: 2021, p_variant: "GT",
      p_odometer_km: 30000, p_grade: "A", p_color: "Red", p_mechanical_notes: "", p_appraisal_notes: "",
      p_photo_urls: ["https://img/1.jpg"], p_starting_price: 1000000, p_reserve_price: 1200000,
      p_buy_now_price: null, p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    const rows = await getMyListings(admin, D2);
    expect(rows.some((r: any) => r.id === id && r.status === "draft")).toBe(true);
    // dealer-scoped: D2's listings do not include the anchor (owned by D1)
    expect(rows.some((r: any) => r.id === ANCHOR)).toBe(false);
  });

  it("getMyBiddingAuctions returns live auctions the dealer has bid on", async () => {
    await bid(D2, 650000);
    const rows = await getMyBiddingAuctions(admin, D2);
    expect(rows.some((r: any) => r.id === ANCHOR)).toBe(true);
    expect(rows[0].current_winner_dealer_id).toBe(D2); // D2 is winning
    // a dealer who never bid sees nothing here
    expect(await getMyBiddingAuctions(admin, D3)).toHaveLength(0);
  });

  it("getMyWins returns ended auctions the dealer won with reserve met", async () => {
    await bid(D2, 800000);
    await bid(D3, 780000); // competition pushes price to 800000 (>= reserve 750000), D2 still winner
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: ANCHOR, p_seconds: -10 });
    const wins = await getMyWins(admin, D2);
    expect(wins.some((r: any) => r.id === ANCHOR)).toBe(true);
    // D3 lost — not a win
    expect(await getMyWins(admin, D3)).toHaveLength(0);
  });

  it("getMySales returns the seller's sold auctions with settlement", async () => {
    await bid(D2, 800000);
    await bid(D3, 780000);
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: ANCHOR, p_seconds: -10 });
    await admin.rpc("close_auction", { p_auction_id: ANCHOR }); // -> sold, settlement inserted
    const sales = await getMySales(admin, D1);
    const row = sales.find((r: any) => r.id === ANCHOR);
    expect(row).toBeDefined();
    const s = Array.isArray(row.settlement) ? row.settlement[0] : row.settlement;
    expect(s.sale_price).toBe(800000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard.test.ts`
Expected: FAIL — cannot find module `../src/lib/dashboard`.

- [ ] **Step 4: Write the query module**

Create `src/lib/dashboard.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

const AUCTION_WITH_VEHICLE = "*, vehicle:vehicles(*)";

// Seller's auctions across every status (draft/live/ended/sold/passed), newest end first.
export async function getMyListings(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_VEHICLE)
    .eq("seller_dealer_id", dealerId)
    .order("end_time", { ascending: false });
  return data ?? [];
}

// Live auctions the dealer has placed a bid on (winning/outbid derived by the caller).
export async function getMyBiddingAuctions(sb: SupabaseClient, dealerId: string) {
  const { data: bidRows } = await sb
    .from("bids")
    .select("auction_id")
    .eq("bidder_dealer_id", dealerId);
  const ids = [...new Set((bidRows ?? []).map((b: { auction_id: string }) => b.auction_id))];
  if (ids.length === 0) return [];
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_VEHICLE)
    .in("id", ids)
    .eq("status", "live")
    .order("end_time", { ascending: true });
  return data ?? [];
}

// Auctions the dealer won: current winner, ended, and reserve met (a real sale to them).
export async function getMyWins(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("auctions")
    .select(AUCTION_WITH_VEHICLE)
    .eq("current_winner_dealer_id", dealerId)
    .lte("end_time", new Date().toISOString())
    .order("end_time", { ascending: false });
  return (data ?? []).filter(
    (a: { current_bid: number | null; reserve_price: number }) =>
      a.current_bid != null && a.current_bid >= a.reserve_price
  );
}

// Seller's completed auctions (sold or passed), with the settlement row when sold.
export async function getMySales(sb: SupabaseClient, dealerId: string) {
  const { data } = await sb
    .from("auctions")
    .select("*, vehicle:vehicles(*), settlement:settlements(*)")
    .eq("seller_dealer_id", dealerId)
    .in("status", ["sold", "passed"])
    .order("end_time", { ascending: false });
  return data ?? [];
}
```

- [ ] **Step 5: Apply the seed and run the test**

Run: `npx supabase db reset && npx vitest run tests/dashboard.test.ts`
Expected: PASS (4/4), output pristine.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard.ts supabase/seed.sql tests/dashboard.test.ts
git commit -m "Add dashboard read queries and seed a draft listing"
```

---

### Task 2: Discard-draft RPC + service (TDD)

**Files:**
- Create: `supabase/migrations/0005_discard_draft.sql`
- Modify: `src/lib/listings/service.ts`
- Test: `tests/dashboard_discard.test.ts`

**Interfaces:**
- Produces RPC `discard_draft_listing(p_auction_id uuid, p_dealer_id uuid) RETURNS text` (`'discarded'` | `'not_owner'` | `'not_draft'`), service-role only.
- Produces `discardDraft(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }>` in `src/lib/listings/service.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard_discard.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, anon, cleanupDrafts } from "./helpers/db";
import { discardDraft } from "../src/lib/listings/service";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const ANCHOR = "a0000000-0000-0000-0000-000000000a01"; // a live auction, not a draft

async function makeDraft(dealer = D1): Promise<string> {
  const { data } = await admin.rpc("create_draft_listing", {
    p_dealer_id: dealer, p_make: "Ford", p_model: "Ranger", p_year: 2020, p_variant: "XLT",
    p_odometer_km: 60000, p_grade: "B", p_color: "Blue", p_mechanical_notes: "", p_appraisal_notes: "",
    p_photo_urls: ["https://img/1.jpg"], p_starting_price: 1000000, p_reserve_price: 1200000,
    p_buy_now_price: null, p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  return data as string;
}

describe("discard_draft_listing", () => {
  beforeEach(cleanupDrafts);

  it("discards an owned draft and deletes its vehicle", async () => {
    const id = await makeDraft(D1);
    const { data: a } = await admin.from("auctions").select("vehicle_id").eq("id", id).single();
    const r = await discardDraft(D1, id);
    expect(r).toEqual({ ok: true });
    const { data: gone } = await admin.from("auctions").select("id").eq("id", id);
    expect(gone).toHaveLength(0);
    const { data: veh } = await admin.from("vehicles").select("id").eq("id", a!.vehicle_id);
    expect(veh).toHaveLength(0);
  });

  it("refuses to discard someone else's draft", async () => {
    const id = await makeDraft(D1);
    expect(await discardDraft(D2, id)).toEqual({ ok: false, reason: "not_owner" });
  });

  it("refuses to discard a non-draft auction", async () => {
    expect(await discardDraft(D1, ANCHOR)).toEqual({ ok: false, reason: "not_draft" });
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const id = await makeDraft(D1);
    const { error } = await anon.rpc("discard_draft_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard_discard.test.ts`
Expected: FAIL — `discardDraft` is not exported / `discard_draft_listing` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0005_discard_draft.sql`:

```sql
-- Slice 3: discard (delete) a draft listing. Owner-gated, drafts only.
create or replace function discard_draft_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'draft' then return 'not_draft'; end if;
  delete from auctions where id = p_auction_id;      -- remove FK first
  delete from vehicles where id = a.vehicle_id;       -- draft's vehicle is unshared
  return 'discarded';
end; $$;

-- Writer is service-role only: revoke the PostgreSQL default PUBLIC grant that
-- anon/authenticated inherit, then grant to service_role.
revoke execute on function discard_draft_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function discard_draft_listing(uuid, uuid) to service_role;
```

- [ ] **Step 4: Add the service function**

Append to `src/lib/listings/service.ts`:

```ts
export async function discardDraft(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("discard_draft_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "discarded" ? { ok: true } : { ok: false, reason: data as string };
}
```

- [ ] **Step 5: Apply the migration and run the test**

Run: `npx supabase db reset && npx vitest run tests/dashboard_discard.test.ts`
Expected: PASS (4/4), output pristine.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0005_discard_draft.sql src/lib/listings/service.ts tests/dashboard_discard.test.ts
git commit -m "Add discard_draft_listing RPC and service function"
```

---

### Task 3: Dashboard page, sections & nav link

**Files:**
- Create: `src/app/dashboard/page.tsx`, `src/components/DashboardSection.tsx`
- Modify: `src/components/Header.tsx`

**Interfaces:**
- Consumes: `getMyListings`/`getMyBiddingAuctions`/`getMyWins`/`getMySales` (Task 1), `getDealerId` (`src/lib/session.ts`), `serverClient` (`src/lib/supabase/server.ts`), `formatNZD` (`src/lib/money.ts`).
- Produces: `DashboardSection` component; the `/dashboard` route.

- [ ] **Step 1: Write `DashboardSection`**

Create `src/components/DashboardSection.tsx`:

```tsx
export function DashboardSection({ title, count, empty, children }: {
  title: string; count: number; empty: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <span className="text-sm text-zinc-500">{count}</span>
      </div>
      {count === 0 ? <p className="text-sm text-zinc-500">{empty}</p> : <div className="space-y-2">{children}</div>}
    </section>
  );
}
```

- [ ] **Step 2: Add the "Dashboard" nav link**

In `src/components/Header.tsx`, add a Dashboard link before the "Sell a vehicle" link, inside the `{dealerId && (...)}` block. Replace the single-link block with a group:

```tsx
      {dealerId && (
        <nav className="flex items-center gap-2">
          <Link href="/dashboard" className="rounded px-3 py-1.5 text-sm font-medium text-zinc-200 hover:text-white">
            Dashboard
          </Link>
          <Link href="/sell" className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
            Sell a vehicle
          </Link>
        </nav>
      )}
```

- [ ] **Step 3: Write the dashboard page**

Create `src/app/dashboard/page.tsx`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { DashboardSection } from "@/components/DashboardSection";
import { getMyListings, getMyBiddingAuctions, getMyWins, getMySales } from "@/lib/dashboard";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}

export default async function DashboardPage() {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");

  const sb = await serverClient();
  const [listings, bidding, wins, sales] = await Promise.all([
    getMyListings(sb, dealerId),
    getMyBiddingAuctions(sb, dealerId),
    getMyWins(sb, dealerId),
    getMySales(sb, dealerId),
  ]);

  const rowClass = "flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-4 py-3";

  return (
    <>
      <Header />
      <main className="mx-auto max-w-4xl px-6 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-white">My activity</h1>

        <DashboardSection title="My listings" count={listings.length} empty="You haven't listed any vehicles yet.">
          {listings.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="text-xs uppercase tracking-wide text-zinc-400">{a.status}</span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="Bidding on" count={bidding.length} empty="You're not bidding on anything right now.">
          {bidding.map((a: any) => (
            <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-zinc-300">{formatNZD(a.current_bid ?? a.starting_price)}</span>
                <span className={a.current_winner_dealer_id === dealerId ? "text-emerald-400 text-xs" : "text-red-400 text-xs"}>
                  {a.current_winner_dealer_id === dealerId ? "Winning" : "Outbid"}
                </span>
              </span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="My wins" count={wins.length} empty="No auctions won yet.">
          {wins.map((a: any) => (
            <Link key={a.id} href={`/won/${a.id}`} className={rowClass}>
              <span className="text-white">{vehicleLabel(a.vehicle)}</span>
              <span className="font-mono text-emerald-400">{formatNZD(a.current_bid ?? a.starting_price)}</span>
            </Link>
          ))}
        </DashboardSection>

        <DashboardSection title="My sales" count={sales.length} empty="No completed sales yet.">
          {sales.map((a: any) => {
            const s = Array.isArray(a.settlement) ? a.settlement[0] : a.settlement;
            return (
              <Link key={a.id} href={`/auction/${a.id}`} className={rowClass}>
                <span className="text-white">{vehicleLabel(a.vehicle)}</span>
                <span className="text-sm">
                  {a.status === "sold" && s
                    ? <span className="font-mono text-emerald-400">{formatNZD(s.sale_price)}</span>
                    : <span className="text-zinc-500">Passed in</span>}
                </span>
              </Link>
            );
          })}
        </DashboardSection>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx next build`
Expected: compiles; `/dashboard` listed as a dynamic route, no server/client boundary errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/page.tsx src/components/DashboardSection.tsx src/components/Header.tsx
git commit -m "Add dealer dashboard page with four activity sections"
```

---

### Task 4: Discard-draft action + button

**Files:**
- Create: `src/app/dashboard/actions.ts`, `src/components/DiscardDraftButton.tsx`
- Modify: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `discardDraft` (Task 2), `getDealerId`, `revalidatePath` (`next/cache`).
- Produces: `discardDraftAction(prev: { error?: string }, formData: FormData): Promise<{ error?: string }>`; `DiscardDraftButton` client component.

- [ ] **Step 1: Write the server action**

Create `src/app/dashboard/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { discardDraft } from "@/lib/listings/service";

const DISCARD_MESSAGES: Record<string, string> = {
  not_owner: "You can only discard your own draft.",
  not_draft: "This listing is already published.",
  error: "Could not discard, try again.",
};

export async function discardDraftAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await discardDraft(dealerId, auctionId);
  if (r.ok) {
    revalidatePath("/dashboard");
    return {};
  }
  return { error: DISCARD_MESSAGES[r.reason ?? "error"] ?? "Could not discard." };
}
```

- [ ] **Step 2: Write the discard button**

Create `src/components/DiscardDraftButton.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { discardDraftAction } from "@/app/dashboard/actions";

export function DiscardDraftButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(discardDraftAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs text-red-400 hover:text-red-300">
        Discard
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-zinc-400">Discard draft?</span>
      <button type="submit" disabled={pending} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
        {pending ? "…" : "Yes"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="text-xs text-zinc-400 hover:text-zinc-200">
        No
      </button>
      {state.error && <span className="text-xs text-red-400">{state.error}</span>}
    </form>
  );
}
```

- [ ] **Step 3: Show the button on draft rows**

In `src/app/dashboard/page.tsx`, import the button and render it on draft listing rows. Add the import:

```tsx
import { DiscardDraftButton } from "@/components/DiscardDraftButton";
```

Replace the "My listings" section's row markup so a draft row carries the discard control (the discard button must NOT be inside the `<Link>` — render the row as a container with the link and the button side by side):

```tsx
        <DashboardSection title="My listings" count={listings.length} empty="You haven't listed any vehicles yet.">
          {listings.map((a: any) => (
            <div key={a.id} className={rowClass}>
              <Link href={`/auction/${a.id}`} className="text-white hover:underline">{vehicleLabel(a.vehicle)}</Link>
              <span className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wide text-zinc-400">{a.status}</span>
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
              </span>
            </div>
          ))}
        </DashboardSection>
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx next build`
Expected: compiles; no server/client boundary errors (the button is `"use client"`, imports only the action).

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/actions.ts src/components/DiscardDraftButton.tsx src/app/dashboard/page.tsx
git commit -m "Add discard-draft action and button to the dashboard"
```

---

### Task 5: Dashboard e2e (discard the seeded draft)

**Files:**
- Create: `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: the running dev server + the seeded DB (globalSetup `supabase db reset`). The seeded draft `a0000000-0000-0000-0000-0000000000d1` (Nissan Navara) is owned by dealer 1 (Auckland Motor Wholesale). Needs no R2.

- [ ] **Step 1: Write the e2e test**

Create `tests/e2e/dashboard.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("dealer sees their activity and can discard a draft", async ({ page }) => {
  await page.goto("/login");
  // Log in as the dealer who owns the seeded draft (Auckland Motor Wholesale = dealer 1).
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");
  await expect(page.getByRole("heading", { name: "My activity" })).toBeVisible();

  // The seeded Nissan Navara draft appears under My listings with a Draft status + Discard.
  const draftRow = page.locator("div", { hasText: "2022 Nissan Navara" }).last();
  await expect(page.getByText("2022 Nissan Navara")).toBeVisible();

  // Discard it (two-step confirm) and confirm it disappears.
  await page.getByRole("button", { name: "Discard" }).first().click();
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(page.getByText("2022 Nissan Navara")).toHaveCount(0);
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/dashboard.spec.ts`
Expected: PASS (globalSetup resets the DB so the seeded draft is present; login as dealer 1 → dashboard → discard → the Navara row is gone). If the login button label differs, reconcile the selector against `src/app/login/page.tsx` rather than changing app code.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/dashboard.spec.ts
git commit -m "Add dashboard e2e covering draft discard"
```

---

## Self-Review

**Spec coverage:**
- §4 route/layout/redirect/snapshot/nav link → Task 3 (page + Header). ✓
- §5 four read queries with correct scoping/derivation → Task 1. ✓
- §6 discard RPC (service_role only, owner+draft gate, deletes vehicle) + service + action + button → Tasks 2, 4. ✓
- §7 components (DashboardSection, rows, DiscardDraftButton, Header) → Tasks 3, 4. ✓
- §8 error handling (redirect, empty states, friendly discard messages, DB-gated) → Tasks 3, 4. ✓
- §9 testing (4 query integration, discard RPC + anon-denied, e2e discard) + seed draft → Tasks 1, 2, 5. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows the code. Task 2 Step 4 and Task 3 Step 2 / Task 4 Step 3 are targeted edits to existing files, with the exact new text given.

**Type consistency:** the four query functions share the `(sb: SupabaseClient, dealerId)` signature across Task 1 (definition), Task 3 (page call sites), and Task 1's tests. `discardDraft(dealerId, auctionId)` and its `{ ok, reason }` shape match between Task 2 (service), Task 4 (action), and the tests. RPC name `discard_draft_listing` and its return strings (`discarded`/`not_owner`/`not_draft`) match across the migration, the service, and `DISCARD_MESSAGES`. The seeded draft id/owner (`a0000000-0000-0000-0000-0000000000d1`, dealer 1, "2022 Nissan Navara") match between the seed (Task 1) and the e2e (Task 5).

**Out of scope (correctly absent):** search/filter/watchlist, notifications, analytics, cancelling/editing live auctions, real payments, auth changes — none added.
