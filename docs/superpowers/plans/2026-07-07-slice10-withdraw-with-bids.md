# Slice 10 — Withdraw-with-bids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seller withdraw a live auction that already has bids — moving it to a new terminal `cancelled` status and notifying every distinct bidder.

**Architecture:** A `withdraw_listing` writer RPC (mirroring `unpublish_listing`) sets a live, owned, bid-on auction to a new `cancelled` enum value and loops `_notify(bidder,'withdrawn',…)` over the distinct bidders. A service + action drive it from a dashboard `WithdrawButton` (shown on live rows that have bids, complementing Slice 6's unpublish on no-bid rows). `cancelled` auctions fall out of every live/sale surface automatically; the auction detail page gets a minimal withdrawn banner.

**Tech Stack:** Next.js 16 (App Router, RSC, server actions, `useActionState`), Supabase local (Postgres + PostgREST), TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-07-slice10-withdraw-with-bids-design.md`
**Branch:** `feat/slice10-withdraw-with-bids` (already created; design committed at `b4d40fb`).

## Global Constraints

- **Money:** integer cents everywhere.
- **New status:** `cancelled`, added via `alter type auction_status add value if not exists 'cancelled';`. Safe to add and use in one migration because the only use is inside the (late-bound) plpgsql function body — same pattern migration 0004 used for `draft`.
- **Notifications constraint:** the existing check is named `notifications_type_check` (verified). Drop-if-exists and recreate it as `check (type in ('outbid','won','sold','withdrawn'))`.
- **Writer security pattern:** `withdraw_listing` is `security definer set search_path = public`, and MUST `revoke execute ... from public, anon, authenticated;` BEFORE `grant execute ... to service_role;` (mirrors `unpublish_listing`).
- **Success token:** the RPC returns `'withdrawn'` on success — distinct from the `cancelled` status (Slice 5 `bought`≠`sold` / Slice 6 `reverted` convention). The service maps `data === 'withdrawn'` → `{ ok: true }`.
- **Distinct bidders:** notify via `select distinct bidder_dealer_id from bids` — a dealer who bid twice gets ONE `withdrawn` notification.
- **Guards (in order):** `not_owner` (missing or seller≠dealer) → `not_live` (status≠live) → `no_bids` (`current_bid is null`) → success.
- **Identity:** always from the httpOnly `dealer_id` cookie via `getDealerId()`; never client input. `serviceClient()` is server-only — never imported into a `"use client"` module.
- **DI pattern:** read functions take `(sb, ...)`; tests pass `admin`.
- **Reuse:** `WithdrawButton` mirrors `UnpublishButton` (two-step confirm) but red/destructive and imports ONLY `@/app/dashboard/actions`. Do not modify `UnpublishButton`/`DiscardDraftButton`.
- **Next.js 16:** before editing a page, skim the App Router page guide under `node_modules/next/dist/docs/` (AGENTS.md). `params` is a Promise — already awaited in the detail page.
- **Vitest:** shared single local DB, `fileParallelism: false`; own-fixture (`createLiveAuction`/`createDraftAuction` + `deleteAuctions`, `beforeEach(resetDb)`); scope assertions to own fixtures.
- **Playwright:** `workers: 1`; FRESH dev server per full run; `listing.spec.ts` stays skipped (R2).
- **Commits:** single line, no co-author trailer. Work only on `feat/slice10-withdraw-with-bids` (never `main`).
- **No credentials.**

## File Structure

- **Create** `supabase/migrations/0011_withdraw.sql` — `cancelled` enum value, extended notifications constraint, `withdraw_listing` RPC.
- **Modify** `src/lib/listings/service.ts` — add `withdrawListing`.
- **Modify** `src/app/dashboard/actions.ts` — add `withdrawAction` + message map.
- **Create** `src/components/WithdrawButton.tsx`.
- **Modify** `src/app/dashboard/page.tsx` — render `WithdrawButton` on live rows with bids.
- **Modify** `src/app/auction/[id]/page.tsx` — minimal `cancelled` state (banner + suppress bid panel/countdown).
- **Modify** `src/app/notifications/page.tsx` — add the `withdrawn` label.
- **Create tests:** `tests/withdraw.test.ts` (Task 1), `tests/withdraw_service.test.ts` (Task 2), `tests/e2e/withdraw.spec.ts` (Task 4).

**Seed ids:** dealers D1 `11111111-1111-1111-1111-111111111111` (Auckland Motor Wholesale), D2 `22222222-2222-2222-2222-222222222222` (Waikato Trade Cars), D3 `33333333-3333-3333-3333-333333333333`. Auction a07 `a0000000-0000-0000-0000-000000000a07` (Ford Ranger 2019, seller D2, live, starting 900000, ends +20min). `createLiveAuction(seller)` / `createDraftAuction(seller)` → Kia Sportage: starting 1,000,000 / reserve 1,200,000.

---

### Task 1: `cancelled` status + `withdraw_listing` RPC

**Files:**
- Create: `supabase/migrations/0011_withdraw.sql`
- Test: `tests/withdraw.test.ts`

**Interfaces:**
- Consumes: existing `_notify(uuid,text,uuid)`, `place_bid`, `createLiveAuction`/`createDraftAuction`/`deleteAuctions`, `getMyBiddingAuctions`.
- Produces (SQL): `auction_status` value `'cancelled'`; `withdraw_listing(uuid, uuid) returns text` (service_role-only); notifications accepts `type='withdrawn'`.

- [ ] **Step 1: Write the failing test**

Create `tests/withdraw.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, createDraftAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111"; // seller / owner
const D2 = "22222222-2222-2222-2222-222222222222"; // bidder
const D3 = "33333333-3333-3333-3333-333333333333"; // bidder

const created: string[] = [];
async function makeLive(dealer = D1): Promise<string> {
  const id = await createLiveAuction(dealer);
  created.push(id);
  return id;
}
async function makeDraft(dealer = D1): Promise<string> {
  const id = await createDraftAuction(dealer);
  created.push(id);
  return id;
}
async function bid(auction: string, dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", { p_auction_id: auction, p_dealer_id: dealer, p_max_amount: max });
  if (error) throw error;
}
async function withdraw(auction: string, dealer: string): Promise<string> {
  const { data, error } = await admin.rpc("withdraw_listing", { p_auction_id: auction, p_dealer_id: dealer });
  if (error) throw error;
  return data as string;
}
async function withdrawnNotifs(recipient: string) {
  const { data } = await admin.from("notifications").select("id")
    .eq("recipient_dealer_id", recipient).eq("type", "withdrawn");
  return data ?? [];
}
async function statusOf(id: string): Promise<string> {
  const { data } = await admin.from("auctions").select("status").eq("id", id).single();
  return data!.status as string;
}

describe("withdraw_listing", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("cancels a live bid-on auction and notifies each distinct bidder once", async () => {
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);   // D2 leads at the 1,000,000 starting price
    await bid(id, D3, 1300000);   // D3 outbids D2 (D2 also gets an 'outbid' notif — a different type)
    await bid(id, D2, 1150000);   // D2 bids again (below D3's proxy) — D2 has now bid twice
    expect(await withdraw(id, D1)).toBe("withdrawn");
    expect(await statusOf(id)).toBe("cancelled");
    expect((await withdrawnNotifs(D2)).length).toBe(1); // distinct: one, not two
    expect((await withdrawnNotifs(D3)).length).toBe(1);
  });

  it("refuses a non-owner and leaves it live", async () => {
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);
    expect(await withdraw(id, D2)).toBe("not_owner");
    expect(await statusOf(id)).toBe("live");
  });

  it("refuses a non-live auction (a draft)", async () => {
    const id = await makeDraft(D1);
    expect(await withdraw(id, D1)).toBe("not_live");
  });

  it("refuses a live auction with no bids", async () => {
    const id = await makeLive(D1);
    expect(await withdraw(id, D1)).toBe("no_bids");
    expect(await statusOf(id)).toBe("live");
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);
    const { error } = await anon.rpc("withdraw_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });

  it("removes a cancelled auction from search and from the bidder's 'Bidding on'", async () => {
    const { getMyBiddingAuctions } = await import("../src/lib/dashboard");
    const id = await makeLive(D1);
    await bid(id, D2, 1100000);
    await withdraw(id, D1);
    const { data: search } = await admin.rpc("search_live_auctions", {
      p_q: null, p_grades: null, p_min_price: null, p_max_price: null, p_region: null, p_sort: null,
    });
    expect((search as { id: string }[]).map((r) => r.id)).not.toContain(id);
    const bidding = await getMyBiddingAuctions(admin, D2);
    expect(bidding.map((a: { id: string }) => a.id)).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/withdraw.test.ts`
Expected: FAIL — `withdraw_listing` does not exist yet (RPC error).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0011_withdraw.sql`:

```sql
-- Slice 10: seller withdraws a live auction that already has bids. Unlike Slice 6's unpublish
-- (no bids → revert to draft), a bid-on auction goes to a new terminal 'cancelled' status and
-- every distinct bidder is notified. Adding the enum value and using it in the (late-bound)
-- function body in one migration is safe — same pattern 0004 used for 'draft'.

alter type auction_status add value if not exists 'cancelled';

-- Allow the new bidder-facing notification type.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('outbid','won','sold','withdrawn'));

create or replace function withdraw_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype; r record;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'live' then return 'not_live'; end if;
  if a.current_bid is null then return 'no_bids'; end if;   -- no bids → use unpublish (revert to draft)
  update auctions set status = 'cancelled' where id = p_auction_id;
  for r in select distinct bidder_dealer_id from bids where auction_id = p_auction_id loop
    perform _notify(r.bidder_dealer_id, 'withdrawn', p_auction_id);
  end loop;
  return 'withdrawn';
end; $$;

-- Writer is service-role only: revoke the PUBLIC default first (Slice 2-9 pattern).
revoke execute on function withdraw_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function withdraw_listing(uuid, uuid) to service_role;
```

- [ ] **Step 4: Apply the migration and run the test**

Run: `npx supabase db reset && npx vitest run tests/withdraw.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify existing bid/notification suites still pass**

Run: `npx vitest run tests/place_bid.test.ts tests/notifications_rpc.test.ts tests/notifications_generation.test.ts`
Expected: PASS — the enum/constraint additions are backward-compatible.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0011_withdraw.sql tests/withdraw.test.ts
git commit -m "Add withdraw_listing RPC and cancelled status for withdrawing a bid-on auction"
```

---

### Task 2: `withdrawListing` service + `withdrawAction`

**Files:**
- Modify: `src/lib/listings/service.ts` (add `withdrawListing`)
- Modify: `src/app/dashboard/actions.ts` (add `withdrawAction` + message map)
- Test: `tests/withdraw_service.test.ts`

**Interfaces:**
- Consumes: `withdraw_listing` RPC (Task 1); `serviceClient`, `getDealerId`, `revalidatePath`, `redirect`.
- Produces: `withdrawListing(dealerId, auctionId): Promise<{ ok: boolean; reason?: string }>`; `withdrawAction(_prev, formData): Promise<{ error?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/withdraw_service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { withdrawListing } from "@/lib/listings/service";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const created: string[] = [];

describe("withdrawListing service", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("withdraws a live bid-on auction owned by the dealer", async () => {
    const id = await createLiveAuction(D1); created.push(id);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1100000 });
    expect(await withdrawListing(D1, id)).toEqual({ ok: true });
    const { data } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(data!.status).toBe("cancelled");
  });

  it("returns the reason for a non-owner", async () => {
    const id = await createLiveAuction(D1); created.push(id);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1100000 });
    expect(await withdrawListing(D2, id)).toEqual({ ok: false, reason: "not_owner" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/withdraw_service.test.ts`
Expected: FAIL — `withdrawListing` is not exported from `@/lib/listings/service`.

- [ ] **Step 3: Add the service function**

In `src/lib/listings/service.ts`, add below `unpublishListing`:

```ts
export async function withdrawListing(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("withdraw_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "withdrawn" ? { ok: true } : { ok: false, reason: data as string };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/withdraw_service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the server action**

In `src/app/dashboard/actions.ts`: update the service import to include `withdrawListing`, and add the message map + action. Change the import line:

```ts
import { discardDraft, unpublishListing } from "@/lib/listings/service";
```

to:

```ts
import { discardDraft, unpublishListing, withdrawListing } from "@/lib/listings/service";
```

Then append:

```ts
const WITHDRAW_MESSAGES: Record<string, string> = {
  not_owner: "You can only withdraw your own listing.",
  not_live: "This listing isn't live.",
  no_bids: "This listing has no bids — unpublish it instead.",
  error: "Could not withdraw, try again.",
};

export async function withdrawAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await withdrawListing(dealerId, auctionId);
  if (r.ok) {
    revalidatePath("/dashboard");
    revalidatePath("/");
    revalidatePath(`/auction/${auctionId}`);
    return {};
  }
  return { error: WITHDRAW_MESSAGES[r.reason ?? "error"] ?? "Could not withdraw." };
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/listings/service.ts src/app/dashboard/actions.ts tests/withdraw_service.test.ts
git commit -m "Add withdrawListing service and withdrawAction"
```

---

### Task 3: `WithdrawButton` + dashboard row + auction-detail cancelled state + notification label

**Files:**
- Create: `src/components/WithdrawButton.tsx`
- Modify: `src/app/dashboard/page.tsx` (render on live rows with bids)
- Modify: `src/app/auction/[id]/page.tsx` (cancelled banner + suppress bid panel/countdown)
- Modify: `src/app/notifications/page.tsx` (add the `withdrawn` label)

**Interfaces:**
- Consumes: `withdrawAction` (Task 2).
- Produces: the `WithdrawButton` component; a `cancelled` auction renders a withdrawn banner and no bid panel; a `withdrawn` notification renders a readable label.

- [ ] **Step 1: Read the Next.js page guide**

Skim the App Router page guide under `node_modules/next/dist/docs/` (server components, `await params`) before editing the pages. Confirm the pattern matches the existing `dashboard/page.tsx` and `auction/[id]/page.tsx`.

- [ ] **Step 2: Create the WithdrawButton**

Create `src/components/WithdrawButton.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { withdrawAction } from "@/app/dashboard/actions";

export function WithdrawButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(withdrawAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs text-red-400 hover:text-red-300">
        Withdraw
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-zinc-400">Withdraw &amp; cancel? Bidders are notified — can&apos;t be undone.</span>
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

- [ ] **Step 3: Render it on the dashboard**

In `src/app/dashboard/page.tsx`, add the import alongside the other component imports:

```ts
import { WithdrawButton } from "@/components/WithdrawButton";
```

Then, in the "My listings" row, add the withdraw line right after the existing unpublish line. Change:

```tsx
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
                {a.status === "live" && a.current_bid == null && <UnpublishButton auctionId={a.id} />}
```

to:

```tsx
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
                {a.status === "live" && a.current_bid == null && <UnpublishButton auctionId={a.id} />}
                {a.status === "live" && a.current_bid != null && <WithdrawButton auctionId={a.id} />}
```

- [ ] **Step 4: Handle the cancelled state on the auction detail page**

In `src/app/auction/[id]/page.tsx`:

(a) After `const isDraft = auction.status === "draft";`, add:

```ts
  const isCancelled = auction.status === "cancelled";
```

(b) After the existing draft banner block (`{isDraft && ( … Draft — not yet live … )}`), add a cancelled banner:

```tsx
      {isCancelled && (
        <div className="mb-4 rounded-lg bg-red-950/40 border border-red-800 px-4 py-2 text-sm text-red-300 font-medium">
          This auction was withdrawn by the seller.
        </div>
      )}
```

(c) Change the `rightPanel` definition so a cancelled auction shows no action panel. Change:

```tsx
  const rightPanel = isDraft ? (
    <PublishPanel auctionId={auction.id} />
  ) : (
    <BidPanel
      auction={auction}
      currentDealerId={currentDealerId}
      initialBids={bids}
    />
  );
```

to:

```tsx
  const rightPanel = isDraft ? (
    <PublishPanel auctionId={auction.id} />
  ) : isCancelled ? null : (
    <BidPanel
      auction={auction}
      currentDealerId={currentDealerId}
      initialBids={bids}
    />
  );
```

(d) Suppress the misleading countdown for a cancelled auction. Change:

```tsx
          {/* Countdown — only meaningful for live auctions */}
          {!isDraft && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span>Time remaining:</span>
              <CountdownTimer endTime={auction.end_time} />
            </div>
          )}
```

to:

```tsx
          {/* Countdown — only meaningful for live auctions */}
          {!isDraft && !isCancelled && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span>Time remaining:</span>
              <CountdownTimer endTime={auction.end_time} />
            </div>
          )}
```

- [ ] **Step 5: Add the notification label**

In `src/app/notifications/page.tsx`, add the `withdrawn` entry to the `LABEL` map:

```ts
const LABEL: Record<string, (v: string) => string> = {
  outbid: (v) => `You were outbid on ${v}`,
  won: (v) => `You won ${v}`,
  sold: (v) => `Your ${v} sold`,
  withdrawn: (v) => `An auction you bid on was withdrawn — ${v}`,
};
```

(`hrefFor` already routes non-`won` types to `/auction/[id]`, which now renders the withdrawn banner — no change needed.)

- [ ] **Step 6: Typecheck, build, and boundary check**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; `/dashboard`, `/auction/[id]`, `/notifications` compile.

Run: `git grep -n "withdrawAction" -- "src/**/*.tsx"`
Expected: only `src/components/WithdrawButton.tsx` (a `"use client"` component importing the action) and `src/app/dashboard/actions.ts` (the definition). `serviceClient` must not reach the client bundle (WithdrawButton imports only the action).

- [ ] **Step 7: Commit**

```bash
git add src/components/WithdrawButton.tsx src/app/dashboard/page.tsx src/app/auction/[id]/page.tsx src/app/notifications/page.tsx
git commit -m "Add WithdrawButton, dashboard wiring, cancelled auction view, and withdrawn notification label"
```

---

### Task 4: e2e withdraw + full green

**Files:**
- Create: `tests/e2e/withdraw.spec.ts`

**Interfaces:**
- Consumes: the running app + a fresh DB (Playwright `globalSetup` resets once). Uses the SPARE a07 (Ford Ranger, seller D2) — untouched-live by every other spec; withdraw runs alphabetically last.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/withdraw.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";

// Two-dealer withdraw on the SPARE seeded Ford Ranger (a07, seller = Waikato Trade Cars / D2,
// starting $9,000). No other e2e spec needs a07 live, and 'withdraw.spec.ts' sorts alphabetically
// last, so cancelling a07 can't affect another spec. Dealer A (Auckland / D1) bids; the owner
// (D2) withdraws it from the dashboard → the row becomes 'cancelled'.
const A07 = "/auction/a0000000-0000-0000-0000-000000000a07";

async function loginAs(page: Page, dealerName: RegExp) {
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
}

test("a seller withdraws a live auction that has bids", async ({ page }) => {
  // Dealer A (Auckland) places a bid on the Ranger.
  await loginAs(page, /Auckland Motor Wholesale/);
  await page.goto(A07);
  await page.getByLabel("Your max bid (NZD $)").fill("11000");
  await page.getByRole("button", { name: "Place bid" }).click();
  await expect(page.getByText("Bid placed successfully.")).toBeVisible();

  // The owner (Waikato Trade Cars) withdraws it from the dashboard.
  await loginAs(page, /Waikato Trade Cars/);
  await page.waitForLoadState("networkidle"); // Next dev prefetch race guard (as dashboard.spec)
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");

  const row = page.locator("div.flex.items-center.justify-between", { hasText: "2019 Ford Ranger" });
  await row.getByRole("button", { name: "Withdraw" }).click();
  await row.getByRole("button", { name: "Yes" }).click();

  // The row now shows cancelled and the Withdraw button is gone.
  await expect(row.getByText("cancelled")).toBeVisible();
  await expect(row.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the full vitest suite (clean DB) — everything green**

Run: `npx supabase db reset && npm test`
Expected: all test files pass, including `tests/withdraw.test.ts` and `tests/withdraw_service.test.ts`. Report totals.

- [ ] **Step 3: Run the full Playwright suite against a fresh dev server**

Ensure nothing is bound to port 3000 (bash: `netstat -ano | grep ':3000' | grep LISTENING`; if found, `taskkill //PID <pid> //F`), then run:

Run: `npm run test:e2e`
Expected: all specs pass (`withdraw.spec.ts` included), `listing.spec.ts` skipped. Playwright manages a fresh dev server + one `globalSetup` reset. If a spec flakes, note which and re-run once; do not weaken assertions.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/withdraw.spec.ts
git commit -m "Add e2e covering a seller withdrawing a live auction with bids"
```

---

## Self-Review

**1. Spec coverage:**
- §4 migration (`cancelled` enum, extended `notifications_type_check`, `withdraw_listing` with guards + distinct-bidder notify + revoke-before-grant) → Task 1. ✓
- §5 service (`withdrawListing`, maps `'withdrawn'`) + action (`withdrawAction`, cookie identity, message map, revalidate) → Task 2. ✓
- §6 UI (`WithdrawButton` red two-step; dashboard render on live+has-bids; auction-detail cancelled banner + no bid panel + no countdown) + the notifications `withdrawn` label → Task 3. ✓
- §7 error handling (guards at DB, redirect on no cookie, cancelled leaves live surfaces) → Task 1 RPC + Task 1 test (search + bidding exclusion) + Task 2 action. ✓
- §8 testing (happy/distinct-bidder, guards not_owner/not_live/no_bids, anon-denied, surface exclusion, service test, e2e on a07) → Tasks 1, 2, 4. ✓
- §3 distinct-bidder-once, terminal cancelled, success token `'withdrawn'`, service_role-only → Task 1 migration + Global Constraints. ✓

**2. Placeholder scan:** No TBD/TODO; every code step is complete; the e2e pins a07/D1/D2 with reasoning; the distinct-bidder arithmetic is spelled out.

**3. Type consistency:** `withdraw_listing(uuid, uuid)` (returns text) used identically in the migration, `tests/withdraw.test.ts`, and `withdrawListing`. `withdrawListing(dealerId, auctionId)` and `withdrawAction(_prev, formData)` names/signatures match across `service.ts`, `actions.ts`, `WithdrawButton`, and the service test. `'withdrawn'` success token and `'withdrawn'` notification type are consistent (RPC returns it; service maps it; constraint allows it; LABEL renders it). Dashboard render condition `a.status === 'live' && a.current_bid != null` is the exact complement of the existing unpublish condition `== null`. The bid arithmetic in the happy-path test (D2 1,100,000 → leads at 1,000,000; D3 1,300,000 → outbids; D2 1,150,000 → below D3 proxy, still a second D2 bid row) yields distinct bidders {D2, D3}, so each gets exactly one `withdrawn`. ✓
