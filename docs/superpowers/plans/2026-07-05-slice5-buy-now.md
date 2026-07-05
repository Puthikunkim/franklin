# Buy Now (instant purchase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in dealer buy a live, un-bid auction outright at its `buy_now_price`, ending it immediately as a sale with a settlement.

**Architecture:** A `service_role`-only `buy_now_listing` SQL writer RPC (mirrors `close_auction`'s settlement insert and the Slice 2–4 revoke/grant pattern) is called from a `"use server"` action that takes the buyer from the httpOnly `dealer_id` cookie. A two-step-confirm `BuyNowButton` on the auction detail page triggers it, and the existing `/won/[id]` page shows the result.

**Tech Stack:** Next.js 16 (App Router, RSC, server actions, `useActionState`), Supabase local (Postgres + PostgREST), Vitest (integration vs local DB), Playwright (e2e).

## Global Constraints

- **This Next.js is v16 and non-standard.** Before writing route/page/action code, read the relevant guide under `node_modules/next/dist/docs/` (cited per task).
- **Money is integer cents** everywhere in the DB and service layer. `formatNZD(cents)` renders it.
- **Writer-RPC security (mandatory):** Postgres grants EXECUTE to PUBLIC by default and anon/authenticated inherit it, so `buy_now_listing` MUST `revoke execute ... from public, anon, authenticated;` BEFORE `grant execute ... to service_role;`. `buy_now_listing` is a writer → `service_role` only (unlike the older anon-callable `place_bid`).
- **The service-role client is server-only.** Never import `@/lib/supabase/service` or `@/lib/purchase/service` into a `"use client"` module. `BuyNowButton.tsx` (client) imports only the `"use server"` action and `formatNZD`.
- **Buyer identity always comes from the httpOnly `dealer_id` cookie** server-side, never from client/form input.
- **Buy-now availability rule:** only while the auction is `live` AND has no bids (`current_bid is null`); and the buyer must not be the seller.
- **Integration tests share ONE local Supabase DB** and run sequentially (`fileParallelism: false`); new tests reset their own state in `beforeEach`.
- **e2e runs with `workers: 1`** and a **fresh** dev server per full run (a stale long-lived dev server degrades the heavier realtime spec). The e2e must buy a **spare** auction (`a03` Honda CR-V) that no other spec needs live, because buy-now permanently sells it and globalSetup resets the DB only once.
- **Commits:** one line, no co-author trailer. Work on branch `feat/slice5-buy-now`; never commit to `main`.
- **No credential-dependent work** in this slice (no R2/external creds).

---

## File Structure

**Created:**
- `supabase/migrations/0007_buy_now.sql` — `buy_now_listing` writer RPC + grants.
- `src/lib/purchase/service.ts` — `buyNow(dealerId, auctionId)` service-role wrapper.
- `src/lib/purchase/actions.ts` — `buyNowAction` (`"use server"`).
- `src/components/BuyNowButton.tsx` — client two-step-confirm button.
- `tests/buy_now.test.ts` — `buy_now_listing` integration tests.
- `tests/buy_now_service.test.ts` — `buyNow` service integration test.
- `tests/e2e/buy-now.spec.ts` — end-to-end purchase flow.

**Modified:**
- `src/app/auction/[id]/page.tsx` — render `BuyNowButton` above the bid panel when eligible.

---

## Task 1: Migration — buy_now_listing RPC

**Files:**
- Create: `supabase/migrations/0007_buy_now.sql`
- Test: `tests/buy_now.test.ts`

**Interfaces:**
- Consumes: existing `auctions`/`settlements` tables; `place_bid` RPC; `test_reset`/`resetDb`; `getMyWins`/`getMySales` from `src/lib/dashboard.ts`; seed auction `a03` (Honda CR-V, seller = dealer 3 `3333…`, `buy_now_price = 1100000`, no bids after reset).
- Produces: `buy_now_listing(p_auction_id uuid, p_buyer_dealer_id uuid) returns text` — `service_role`-only. Returns the distinct token `'bought'` on a fresh successful purchase; `'not_found'` / `'no_buy_now'` / `'has_bids'` / `'is_seller'` / or the current non-live `status` string (`'sold'`/`'ended'`/`'passed'`/`'draft'`) otherwise. The success token must be distinct from the `'sold'` status so a second buyer on an already-sold auction is NOT told they succeeded. On success sets `status='sold'`, `current_bid=buy_now_price`, `current_winner_dealer_id=buyer`, `end_time=now()`, and inserts a settlement (`sale_price=buy_now_price`, default fees) `on conflict do nothing`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0007_buy_now.sql`:

```sql
-- Slice 5: buy-now. Purchase a live, un-bid auction outright at its buy_now_price.
-- Ends the auction as a sale to the buyer and creates the settlement, mirroring
-- close_auction. Buy-now is only allowed before the first bid.
create or replace function buy_now_listing(p_auction_id uuid, p_buyer_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found then return 'not_found'; end if;
  if a.status <> 'live' then return a.status; end if;          -- already sold/ended/draft/passed
  if a.buy_now_price is null then return 'no_buy_now'; end if;
  if a.current_bid is not null then return 'has_bids'; end if; -- buy-now only before the first bid
  if a.seller_dealer_id = p_buyer_dealer_id then return 'is_seller'; end if;

  update auctions
     set status = 'sold',
         current_bid = a.buy_now_price,          -- sale price (mirrors close_auction using current_bid)
         current_winner_dealer_id = p_buyer_dealer_id,
         end_time = now()                        -- genuinely ended, so My wins / My sales pick it up
   where id = p_auction_id;

  insert into settlements (auction_id, sale_price)
     values (p_auction_id, a.buy_now_price)
     on conflict (auction_id) do nothing;        -- never resell / double-settle
  return 'bought';   -- distinct from the 'sold' STATUS: only a fresh purchase returns this
end; $$;

-- Writer is service-role only: revoke the PostgreSQL default PUBLIC grant that
-- anon/authenticated inherit, then grant to service_role (Slice 2–4 pattern).
revoke execute on function buy_now_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function buy_now_listing(uuid, uuid) to service_role;
```

- [ ] **Step 2: Apply the migration to the local DB**

Run: `npx supabase db reset`
Expected: re-runs all migrations (incl. `0007`) + reseeds, ending with a success line. Required before the integration tests can see the new function. (If the container recreate transiently fails with "error running container", just re-run the command.)

- [ ] **Step 3: Write the failing tests**

Create `tests/buy_now.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, anon, resetDb } from "./helpers/db";
import { getMyWins, getMySales } from "../src/lib/dashboard";

const D1 = "11111111-1111-1111-1111-111111111111"; // buyer (Auckland)
const D2 = "22222222-2222-2222-2222-222222222222"; // a rival bidder
const D3 = "33333333-3333-3333-3333-333333333333"; // SELLER of the CR-V
const CRV = "a0000000-0000-0000-0000-000000000a03"; // Honda CR-V, seller D3, buy_now 1100000, no bids after reset
const CRV_BUY_NOW = 1100000;

async function buyNow(auction: string, buyer: string) {
  const { data, error } = await admin.rpc("buy_now_listing", {
    p_auction_id: auction, p_buyer_dealer_id: buyer,
  });
  if (error) throw error;
  return data as string;
}

describe("buy_now_listing", () => {
  beforeEach(resetDb);

  it("sells a live, un-bid auction to a non-seller buyer and settles it", async () => {
    expect(await buyNow(CRV, D1)).toBe("bought");
    const { data: a } = await admin.from("auctions").select("*").eq("id", CRV).single();
    expect(a!.status).toBe("sold");
    expect(a!.current_winner_dealer_id).toBe(D1);
    expect(a!.current_bid).toBe(CRV_BUY_NOW);
    expect(new Date(a!.end_time).getTime()).toBeLessThanOrEqual(Date.now() + 2000);
    const { data: s } = await admin.from("settlements").select("*").eq("auction_id", CRV).single();
    expect(s!.sale_price).toBe(CRV_BUY_NOW);
    expect(s!.seller_fee).toBe(20000);
    expect(s!.buyer_fee).toBe(2000);
  });

  it("refuses once bidding has started", async () => {
    await admin.rpc("place_bid", { p_auction_id: CRV, p_dealer_id: D2, p_max_amount: 750000 });
    expect(await buyNow(CRV, D1)).toBe("has_bids");
    const { data: a } = await admin.from("auctions").select("status").eq("id", CRV).single();
    expect(a!.status).toBe("live");
  });

  it("refuses to let the seller buy their own listing", async () => {
    expect(await buyNow(CRV, D3)).toBe("is_seller");
  });

  it("refuses an auction with no buy_now_price", async () => {
    await admin.from("auctions").update({ buy_now_price: null }).eq("id", CRV);
    expect(await buyNow(CRV, D1)).toBe("no_buy_now");
  });

  it("is idempotent — a second buy returns the sold status (not 'bought') and never double-settles", async () => {
    expect(await buyNow(CRV, D1)).toBe("bought");
    expect(await buyNow(CRV, D2)).toBe("sold"); // already-sold status, NOT a fresh purchase
    const { data: s } = await admin.from("settlements").select("id").eq("auction_id", CRV);
    expect(s).toHaveLength(1);
    const { data: a } = await admin.from("auctions").select("current_winner_dealer_id").eq("id", CRV).single();
    expect(a!.current_winner_dealer_id).toBe(D1); // D2 did not steal it
  });

  it("makes the sale show in the buyer's wins and the seller's sales", async () => {
    await buyNow(CRV, D1);
    expect((await getMyWins(admin, D1)).some((r: { id: string }) => r.id === CRV)).toBe(true);
    expect((await getMySales(admin, D3)).some((r: { id: string }) => r.id === CRV)).toBe(true);
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const { error } = await anon.rpc("buy_now_listing", { p_auction_id: CRV, p_buyer_dealer_id: D1 });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/buy_now.test.ts`
Expected: all 7 tests PASS (migration applied in Step 2). If a test fails, fix the migration SQL and re-run `npx supabase db reset` before re-testing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_buy_now.sql tests/buy_now.test.ts
git commit -m "Add buy_now_listing RPC for instant purchase of an un-bid auction"
```

---

## Task 2: Service + server action (`src/lib/purchase/`)

**Files:**
- Create: `src/lib/purchase/service.ts`, `src/lib/purchase/actions.ts`
- Test: `tests/buy_now_service.test.ts`

**Interfaces:**
- Consumes: `buy_now_listing` RPC (Task 1); `serviceClient()` from `@/lib/supabase/service`; `getDealerId()` from `@/lib/session`; `revalidatePath` (next/cache); `redirect` (next/navigation).
- Produces:
  - `buyNow(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }>` — `{ ok: true }` when the RPC returns `'bought'` (a fresh purchase), else `{ ok: false, reason: <token> }`.
  - `buyNowAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }>` (`"use server"`) — cookie identity (redirect `/login` if absent); on success revalidates `/`, `/dashboard`, `/auction/${auctionId}` then `redirect('/won/${auctionId}')`; on failure returns a friendly `{ error }`.

- [ ] **Step 1: Read the Next.js docs for the action**

Read: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md` and `.../revalidatePath.md`. Confirm `redirect()` throws to navigate (so code after it on the success path doesn't run) and mirrors `src/app/dashboard/actions.ts`.

- [ ] **Step 2: Write the failing service test**

Create `tests/buy_now_service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb } from "./helpers/db";
import { buyNow } from "../src/lib/purchase/service";

const D1 = "11111111-1111-1111-1111-111111111111"; // buyer
const D3 = "33333333-3333-3333-3333-333333333333"; // seller of the CR-V
const CRV = "a0000000-0000-0000-0000-000000000a03";

describe("buyNow service", () => {
  beforeEach(resetDb);

  it("returns ok and marks the auction sold on a successful purchase", async () => {
    expect(await buyNow(D1, CRV)).toEqual({ ok: true });
    const { data: a } = await admin.from("auctions").select("status").eq("id", CRV).single();
    expect(a!.status).toBe("sold");
  });

  it("returns the reason when the seller tries to buy their own listing", async () => {
    expect(await buyNow(D3, CRV)).toEqual({ ok: false, reason: "is_seller" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/buy_now_service.test.ts`
Expected: FAIL — cannot resolve `../src/lib/purchase/service`.

- [ ] **Step 4: Implement the service**

Create `src/lib/purchase/service.ts`:

```ts
import { serviceClient } from "@/lib/supabase/service";

// Server-only: writes via the service-role client. NEVER import into a "use client" module.
export async function buyNow(
  dealerId: string,
  auctionId: string
): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("buy_now_listing", {
    p_auction_id: auctionId,
    p_buyer_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  // 'bought' means THIS call completed the purchase. Any other token (including the
  // 'sold' STATUS of an already-sold auction) is a failure for this buyer.
  return data === "bought" ? { ok: true } : { ok: false, reason: data as string };
}
```

- [ ] **Step 5: Implement the server action**

Create `src/lib/purchase/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { buyNow } from "@/lib/purchase/service";

const BUY_NOW_MESSAGES: Record<string, string> = {
  has_bids: "Bidding has started — buy now is no longer available.",
  is_seller: "You can't buy your own listing.",
  no_buy_now: "This listing has no buy-now price.",
  sold: "This auction is no longer available.",
  ended: "This auction is no longer available.",
  passed: "This auction is no longer available.",
  draft: "This auction is no longer available.",
  not_found: "This auction is no longer available.",
  error: "Could not complete the purchase, try again.",
};

export async function buyNowAction(
  _prev: { error?: string },
  formData: FormData
): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await buyNow(dealerId, auctionId);
  if (r.ok) {
    // Revalidate every surface the sale changes, then show the settlement.
    revalidatePath("/");
    revalidatePath("/dashboard");
    revalidatePath(`/auction/${auctionId}`);
    redirect(`/won/${auctionId}`); // throws NEXT_REDIRECT — nothing after runs on success
  }
  return { error: BUY_NOW_MESSAGES[r.reason ?? "error"] ?? "Could not complete the purchase." };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/buy_now_service.test.ts`
Expected: both tests PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/purchase/service.ts src/lib/purchase/actions.ts tests/buy_now_service.test.ts
git commit -m "Add buy-now write path: buyNow service and buyNowAction"
```

---

## Task 3: BuyNowButton + auction detail wiring

**Files:**
- Create: `src/components/BuyNowButton.tsx`
- Modify: `src/app/auction/[id]/page.tsx`

**Interfaces:**
- Consumes: `buyNowAction` (Task 2); `formatNZD` from `@/lib/money`; the detail page's existing `auction`, `isDraft`, `currentDealerId`.
- Produces: `BuyNowButton({ auctionId, buyNowPrice })` client component (two-step confirm, submits `buyNowAction` via `useActionState`). The detail page renders it above the right-column panel when `!isDraft && auction.status === 'live' && auction.buy_now_price != null && auction.current_bid == null && auction.seller_dealer_id !== currentDealerId`.

- [ ] **Step 1: Read the Next.js docs for the page edit**

Read: `node_modules/next/dist/docs/01-app/02-guides/forms.md` (server-action forms + `useActionState`). The detail page already uses `await params` (Next 15+ async) — follow the existing file's conventions.

- [ ] **Step 2: Implement the BuyNowButton**

Create `src/components/BuyNowButton.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { buyNowAction } from "@/lib/purchase/actions";
import { formatNZD } from "@/lib/money";

export function BuyNowButton({ auctionId, buyNowPrice }: { auctionId: string; buyNowPrice: number }) {
  const [state, action, pending] = useActionState(buyNowAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-3 text-sm font-semibold text-white"
      >
        Buy now for {formatNZD(buyNowPrice)}
      </button>
    );
  }

  return (
    <form action={action} className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 space-y-3">
      <input type="hidden" name="auctionId" value={auctionId} />
      <p className="text-sm text-zinc-200">
        Buy now for {formatNZD(buyNowPrice)}? You&apos;ll pay a $20 buyer fee.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Buying…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: Wire it into the auction detail page**

Edit `src/app/auction/[id]/page.tsx`.

(a) Add the import (after the existing `WatchButton` import):

```tsx
import { BuyNowButton } from "@/components/BuyNowButton";
```

(b) Immediately AFTER the `const rightPanel = ...` block and BEFORE the `return (`, add the eligibility flag:

```tsx
  // Buy-now is offered only on a live auction that still has no bids, has a
  // buy-now price, and is being viewed by someone other than the seller.
  const canBuyNow =
    !isDraft &&
    auction.status === "live" &&
    auction.buy_now_price != null &&
    auction.current_bid == null &&
    auction.seller_dealer_id !== currentDealerId;
```

(c) Replace the right-column block:

```tsx
        {/* Right column: publish panel (draft) or bid panel (live) */}
        <div className="lg:col-span-1">
          {rightPanel}
        </div>
```

with:

```tsx
        {/* Right column: buy-now (when eligible) above the publish/bid panel */}
        <div className="lg:col-span-1 space-y-4">
          {canBuyNow && (
            <BuyNowButton auctionId={auction.id} buyNowPrice={auction.buy_now_price!} />
          )}
          {rightPanel}
        </div>
```

- [ ] **Step 4: Verify it builds and typechecks**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 5: Verify the service client did not leak into a client module**

Run: `git grep -n "lib/supabase/service\|lib/purchase/service" src/components`
Expected: no match. `BuyNowButton.tsx` must import only `@/lib/purchase/actions` and `@/lib/money`, never the service.

- [ ] **Step 6: Commit**

```bash
git add src/components/BuyNowButton.tsx src/app/auction/[id]/page.tsx
git commit -m "Add BuyNowButton to the auction detail page for eligible live auctions"
```

---

## Task 4: End-to-end test + full suite green

**Files:**
- Create: `tests/e2e/buy-now.spec.ts`

**Interfaces:**
- Consumes: the running app (Playwright `webServer` runs `npm run dev`); `global-setup.ts` resets the DB to seed before the run; the seeded Honda CR-V (`a03`, seller = dealer 3, `buy_now_price = 1100000`, no bids); the `/won/[id]` sold view (renders "Settlement arranged", "Auction sold", `formatNZD(sale_price)` = "$11,000", and a "Buyer fee" row).
- Produces: an e2e spec that logs in as dealer 1, opens the CR-V, buys it now, and confirms the settlement page.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/buy-now.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Buys the Honda CR-V (a03, seller = dealer 3) — a SPARE seeded auction no other
// e2e spec needs to stay live. buy-now permanently sells it and globalSetup resets
// the DB only once, so using a01 (bidding) / a02 (discovery, realtime) would break
// those specs by execution order.
test("dealer buys a live auction outright with Buy now", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click(); // dealer 1 (buyer)
  await expect(page).toHaveURL("/");

  // Narrow to the CR-V and open it.
  await page.getByPlaceholder("Search make, model, variant").fill("Honda");
  await page.getByRole("heading", { name: /Honda CR-V/ }).click();
  await expect(page).toHaveURL(/\/auction\//);

  // Buy it now (two-step confirm).
  await page.getByRole("button", { name: /Buy now for/ }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  // Lands on the settlement page showing the sale + fees.
  await expect(page).toHaveURL(/\/won\//);
  await expect(page.getByRole("heading", { name: "Settlement arranged" })).toBeVisible();
  await expect(page.getByText("Auction sold")).toBeVisible();
  await expect(page.getByText("$11,000")).toBeVisible(); // buy_now_price sale price
  await expect(page.getByText("Buyer fee")).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `npx playwright test tests/e2e/buy-now.spec.ts`
Expected: PASS. (globalSetup resets the DB first; Playwright starts the dev server.) If the Buy-now button isn't found, confirm the CR-V has no bids in seed and that `canBuyNow` includes `current_bid == null`.

- [ ] **Step 3: Run the full integration suite**

Run: `npx supabase db reset && npm test`
Expected: all Vitest files PASS (Slices 1–5). If `db reset` transiently fails to recreate a container, re-run it, then `npm test`.

- [ ] **Step 4: Run the full e2e suite (fresh server, twice)**

First ensure no stale dev server is holding port 3000 (a degraded long-lived server makes the realtime spec flake); if one is, stop it so Playwright starts a fresh one.

Run: `npx playwright test` — expect bidding, buy-now, dashboard, discovery, realtime green and listing skipped (R2). Run it a **second** time to confirm stability. If the last (realtime) spec flakes on a reused/degraded server, re-run with a fresh dev server.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/buy-now.spec.ts
git commit -m "Add buy-now e2e covering purchase to settlement"
```

---

## Self-Review

**Spec coverage (§ of `2026-07-05-slice5-buy-now-design.md`):**
- §4 `buy_now_listing` (guards, sold+winner+current_bid+end_time, settlement, revoke-before-grant) → Task 1. ✅
- §5 `buyNow` service + `buyNowAction` (cookie identity, revalidate `/`+`/dashboard`+`/auction/[id]`, redirect `/won`) → Task 2. ✅
- §6 `BuyNowButton` (two-step confirm) + detail-page eligibility gate → Task 3. ✅
- §7 error handling (friendly messages, RPC as guardrail, cookie redirect) → Tasks 2, 3. ✅
- §8 integration (happy path, has_bids, is_seller, idempotent/no double-settle, no_buy_now, dashboard wins/sales, anon-denied) + e2e → Tasks 1, 4. ✅
- §8 invariant (anon cannot execute; never resold) → Task 1. ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `buyNow(dealerId, auctionId)` and `buyNowAction(_prev, formData)` signatures match across Tasks 2–3; RPC param names (`p_auction_id`, `p_buyer_dealer_id`) match between Task 1 SQL and Task 2 caller; `BuyNowButton({ auctionId, buyNowPrice })` props match its detail-page usage; the reason strings returned by the RPC (`has_bids`/`is_seller`/`no_buy_now`/`sold`/…) match the `BUY_NOW_MESSAGES` keys in Task 2. ✅

**Auction-choice consistency:** integration/service tests use `a03` (isolated per `resetDb`), and the e2e also uses `a03` (the spare auction, safe for the shared-DB single-reset e2e run). ✅
