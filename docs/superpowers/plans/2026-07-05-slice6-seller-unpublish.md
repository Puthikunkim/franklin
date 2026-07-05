# Seller Unpublish (revert live → draft) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seller revert a live, un-bid auction they own back to `draft` (to edit and relist via the existing draft flow).

**Architecture:** A `service_role`-only `unpublish_listing` SQL writer RPC (mirrors `discard_draft_listing`, revoke-before-grant) is called from a `"use server"` action that takes the seller from the httpOnly cookie. A two-step-confirm `UnpublishButton` on the dashboard "My listings" live rows triggers it; edit/relist reuse the existing `PublishPanel` + `/sell/[id]`.

**Tech Stack:** Next.js 16 (App Router, RSC, server actions, `useActionState`), Supabase local (Postgres + PostgREST), Vitest (integration vs local DB), Playwright (e2e).

## Global Constraints

- **This Next.js is v16 and non-standard.** Before writing route/page/action code, read the relevant guide under `node_modules/next/dist/docs/` (cited per task).
- **Writer-RPC security (mandatory):** Postgres grants EXECUTE to PUBLIC by default and anon/authenticated inherit it, so `unpublish_listing` MUST `revoke execute ... from public, anon, authenticated;` BEFORE `grant execute ... to service_role;`. It is a writer → `service_role` only.
- **The service-role client is server-only.** Never import `@/lib/supabase/service` or `@/lib/listings/service` into a `"use client"` module. `UnpublishButton.tsx` (client) imports only the `"use server"` action.
- **Seller identity always comes from the httpOnly `dealer_id` cookie** server-side, never from client/form input.
- **Availability rule:** unpublish only when the auction is `status='live'` AND `current_bid is null` AND owned by the acting dealer.
- **Success token:** the RPC returns `'reverted'` on success; guards return `'not_owner'`/`'not_live'`/`'has_bids'`. The service maps ONLY `'reverted'` → `{ok:true}`.
- **Integration tests share ONE local Supabase DB** and run sequentially (`fileParallelism: false`). Tests that mutate auctions to `draft` MUST build their own fixture (`create_draft_listing` → `publish_listing`) and delete it in `afterEach` — reverting a *seeded* auction to draft would leak past `test_reset` (which only resets non-draft rows). Read-only guard cases may use seed rows.
- **e2e runs with `workers: 1`** and a **fresh** dev server per full run. The e2e mutates the seeded Hilux (`a06`); it is the spare auction (`a01` is bid on by bidding.spec, `a02` by discovery/realtime, `a03` sold by buy-now), and globalSetup resets the DB only once, so the new spec (alphabetically last) reverts `a06` after every other spec has run.
- **Commits:** one line, no co-author trailer. Work on branch `feat/slice6-seller-unpublish`; never commit to `main`.
- **No credential-dependent work** in this slice (no R2/external creds).

---

## File Structure

**Created:**
- `supabase/migrations/0008_unpublish.sql` — `unpublish_listing` writer RPC + grants.
- `src/components/UnpublishButton.tsx` — client two-step-confirm button.
- `tests/unpublish.test.ts` — `unpublish_listing` integration tests.
- `tests/unpublish_service.test.ts` — `unpublishListing` service integration test.
- `tests/e2e/unpublish.spec.ts` — end-to-end revert-to-draft flow.

**Modified:**
- `tests/helpers/db.ts` — add `createLiveAuction` + `deleteAuctions` shared test helpers.
- `src/lib/listings/service.ts` — add `unpublishListing`.
- `src/app/dashboard/actions.ts` — add `unpublishAction`.
- `src/app/dashboard/page.tsx` — render `UnpublishButton` on live no-bid My-listings rows.

---

## Task 1: Migration + test helpers + RPC integration tests

**Files:**
- Create: `supabase/migrations/0008_unpublish.sql`
- Modify: `tests/helpers/db.ts`
- Test: `tests/unpublish.test.ts`

**Interfaces:**
- Consumes: existing `auctions`/`bids`/`vehicles` tables; `create_draft_listing`, `publish_listing`, `place_bid` RPCs; `test_reset`/`resetDb`; `admin`/`anon` clients; seed draft `a0000000-0000-0000-0000-0000000000d1` (dealer 1).
- Produces:
  - `unpublish_listing(p_auction_id uuid, p_dealer_id uuid) returns text` — `service_role`-only. Returns `'reverted'` on success (sets `status='draft'`, `start_time=null`); `'not_owner'` / `'not_live'` / `'has_bids'` otherwise.
  - `createLiveAuction(dealer: string): Promise<string>` (in `tests/helpers/db.ts`) — creates a published, un-bid auction owned by `dealer`, returns its id.
  - `deleteAuctions(ids: string[]): Promise<void>` (in `tests/helpers/db.ts`) — deletes the given auctions plus their bids and vehicles (FK-safe order).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0008_unpublish.sql`:

```sql
-- Slice 6: seller unpublish. Revert a live, un-bid auction (owned by the dealer)
-- back to a draft, so the seller can edit and republish via the existing draft flow.
create or replace function unpublish_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'live' then return 'not_live'; end if;          -- only a live auction can be unpublished
  if a.current_bid is not null then return 'has_bids'; end if;   -- never pull a listing out from under bidders
  update auctions set status = 'draft', start_time = null where id = p_auction_id;
  return 'reverted';
end; $$;

-- Writer is service-role only: revoke the PostgreSQL default PUBLIC grant that
-- anon/authenticated inherit, then grant to service_role (Slice 2–5 pattern).
revoke execute on function unpublish_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function unpublish_listing(uuid, uuid) to service_role;
```

- [ ] **Step 2: Add the shared test helpers**

Edit `tests/helpers/db.ts`. Append these two exported helpers at the end of the file (they use the existing `admin` client already defined there):

```ts
// Create a published (live), un-bid auction owned by `dealer` and return its id.
// The caller is responsible for cleanup via deleteAuctions([...]).
export async function createLiveAuction(dealer: string): Promise<string> {
  const { data: id } = await admin.rpc("create_draft_listing", {
    p_dealer_id: dealer, p_make: "Kia", p_model: "Sportage", p_year: 2021, p_variant: "GT",
    p_odometer_km: 30000, p_grade: "A", p_color: "Red", p_mechanical_notes: "", p_appraisal_notes: "",
    p_photo_urls: ["https://img/1.jpg"], p_starting_price: 1000000, p_reserve_price: 1200000,
    p_buy_now_price: 1500000, p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: dealer });
  return id as string;
}

// Delete test-created auctions and their bids + vehicles (FK-safe order), so
// reverted-to-draft or leftover-live fixtures never leak into later shared-DB tests.
export async function deleteAuctions(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { data: rows } = await admin.from("auctions").select("vehicle_id").in("id", ids);
  const vids = (rows ?? []).map((r: { vehicle_id: string }) => r.vehicle_id);
  await admin.from("bids").delete().in("auction_id", ids);
  await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
}
```

- [ ] **Step 3: Apply the migration to the local DB**

Run: `npx supabase db reset`
Expected: re-runs all migrations (incl. `0008`) + reseeds, ending with a success line. Required before the integration tests can see the new function. (If the container recreate transiently fails with "error running container", re-run the command.)

- [ ] **Step 4: Write the failing tests**

Create `tests/unpublish.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111"; // owner
const D2 = "22222222-2222-2222-2222-222222222222"; // another dealer
const SEED_DRAFT = "a0000000-0000-0000-0000-0000000000d1"; // seeded Nissan Navara draft (dealer 1)

const created: string[] = [];
async function makeLive(dealer = D1): Promise<string> {
  const id = await createLiveAuction(dealer);
  created.push(id);
  return id;
}
async function unpublish(auction: string, dealer: string) {
  const { data, error } = await admin.rpc("unpublish_listing", {
    p_auction_id: auction, p_dealer_id: dealer,
  });
  if (error) throw error;
  return data as string;
}

describe("unpublish_listing", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("reverts a live, un-bid, owned auction to a draft", async () => {
    const id = await makeLive(D1);
    expect(await unpublish(id, D1)).toBe("reverted");
    const { data: a } = await admin.from("auctions").select("status, start_time").eq("id", id).single();
    expect(a!.status).toBe("draft");
    expect(a!.start_time).toBeNull();
  });

  it("refuses a non-owner and leaves it live", async () => {
    const id = await makeLive(D1);
    expect(await unpublish(id, D2)).toBe("not_owner");
    const { data: a } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(a!.status).toBe("live");
  });

  it("refuses a non-live auction (a draft)", async () => {
    expect(await unpublish(SEED_DRAFT, D1)).toBe("not_live");
  });

  it("refuses once bidding has started and leaves it live", async () => {
    const id = await makeLive(D1);
    await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: D2, p_max_amount: 1000000 });
    expect(await unpublish(id, D1)).toBe("has_bids");
    const { data: a } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(a!.status).toBe("live");
  });

  it("leaves a valid draft that publish_listing can relist", async () => {
    const id = await makeLive(D1);
    await unpublish(id, D1);
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(r).toBe("live");
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const id = await makeLive(D1);
    const { error } = await anon.rpc("unpublish_listing", { p_auction_id: id, p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unpublish.test.ts`
Expected: all 6 tests PASS (migration applied in Step 3). Then run the full suite to confirm the new helpers/tests don't leak state: `npm test` → all green. If a test fails, fix the migration SQL and re-run `npx supabase db reset` before re-testing.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0008_unpublish.sql tests/helpers/db.ts tests/unpublish.test.ts
git commit -m "Add unpublish_listing RPC to revert a live un-bid auction to draft"
```

---

## Task 2: Service + server action

**Files:**
- Modify: `src/lib/listings/service.ts`, `src/app/dashboard/actions.ts`
- Test: `tests/unpublish_service.test.ts`

**Interfaces:**
- Consumes: `unpublish_listing` RPC (Task 1); `createLiveAuction`/`deleteAuctions` (Task 1); `serviceClient()` from `@/lib/supabase/service`; `getDealerId()`; `revalidatePath`; `redirect`.
- Produces:
  - `unpublishListing(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }>` (in `src/lib/listings/service.ts`) — `{ ok: true }` when the RPC returns `'reverted'`, else `{ ok: false, reason: <status> }`.
  - `unpublishAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }>` (`"use server"`, in `src/app/dashboard/actions.ts`) — cookie identity (redirect `/login` if absent); on success revalidates `/dashboard`, `/`, `/auction/${auctionId}` and returns `{}`; on failure returns a friendly `{ error }`.

- [ ] **Step 1: Read the Next.js docs for the action**

Read: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md` and `.../redirect.md`. Confirm usage mirrors the existing `discardDraftAction` in the same file.

- [ ] **Step 2: Write the failing service test**

Create `tests/unpublish_service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import { unpublishListing } from "../src/lib/listings/service";

const D1 = "11111111-1111-1111-1111-111111111111"; // owner
const D2 = "22222222-2222-2222-2222-222222222222"; // another dealer

const created: string[] = [];
async function makeLive(dealer = D1): Promise<string> {
  const id = await createLiveAuction(dealer);
  created.push(id);
  return id;
}

describe("unpublishListing service", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("reverts a live auction and returns ok", async () => {
    const id = await makeLive(D1);
    expect(await unpublishListing(D1, id)).toEqual({ ok: true });
    const { data: a } = await admin.from("auctions").select("status").eq("id", id).single();
    expect(a!.status).toBe("draft");
  });

  it("returns the reason when a non-owner tries", async () => {
    const id = await makeLive(D1);
    expect(await unpublishListing(D2, id)).toEqual({ ok: false, reason: "not_owner" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unpublish_service.test.ts`
Expected: FAIL — `unpublishListing` is not exported from `src/lib/listings/service.ts`.

- [ ] **Step 4: Implement the service function**

Edit `src/lib/listings/service.ts`. Append this function at the end of the file (it uses the `serviceClient` already imported at the top):

```ts
export async function unpublishListing(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("unpublish_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "reverted" ? { ok: true } : { ok: false, reason: data as string };
}
```

- [ ] **Step 5: Implement the server action**

Edit `src/app/dashboard/actions.ts`. Add `unpublishListing` to the existing import from `@/lib/listings/service` (which already imports `discardDraft`), then append the action + its message map:

```ts
const UNPUBLISH_MESSAGES: Record<string, string> = {
  not_owner: "You can only unpublish your own listing.",
  not_live: "This listing isn't live.",
  has_bids: "This listing has bids and can't be unpublished.",
  error: "Could not unpublish, try again.",
};

export async function unpublishAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await unpublishListing(dealerId, auctionId);
  if (r.ok) {
    revalidatePath("/dashboard");
    revalidatePath("/");
    revalidatePath(`/auction/${auctionId}`);
    return {};
  }
  return { error: UNPUBLISH_MESSAGES[r.reason ?? "error"] ?? "Could not unpublish." };
}
```

The import line at the top of `src/app/dashboard/actions.ts` becomes:

```ts
import { discardDraft, unpublishListing } from "@/lib/listings/service";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unpublish_service.test.ts`
Expected: both tests PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/listings/service.ts src/app/dashboard/actions.ts tests/unpublish_service.test.ts
git commit -m "Add unpublish write path: unpublishListing service and unpublishAction"
```

---

## Task 3: UnpublishButton + dashboard wiring

**Files:**
- Create: `src/components/UnpublishButton.tsx`
- Modify: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `unpublishAction` (Task 2); the dashboard "My listings" row (which already has each auction's `status` and `current_bid`).
- Produces: `UnpublishButton({ auctionId })` client component (two-step confirm, submits `unpublishAction`). The dashboard renders it on a My-listings row only when `a.status === 'live' && a.current_bid == null`.

- [ ] **Step 1: Read the Next.js docs for the page edit**

Read: `node_modules/next/dist/docs/01-app/02-guides/forms.md` (server-action forms + `useActionState`). Model the component on the existing `src/components/DiscardDraftButton.tsx`.

- [ ] **Step 2: Implement the UnpublishButton**

Create `src/components/UnpublishButton.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { unpublishAction } from "@/app/dashboard/actions";

export function UnpublishButton({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(unpublishAction, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}
        className="text-xs text-amber-400 hover:text-amber-300">
        Unpublish
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="auctionId" value={auctionId} />
      <span className="text-xs text-zinc-400">Unpublish to draft?</span>
      <button type="submit" disabled={pending} className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50">
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

- [ ] **Step 3: Wire it into the dashboard My-listings rows**

Edit `src/app/dashboard/page.tsx`.

(a) Add the import (next to the existing `DiscardDraftButton` import):

```tsx
import { UnpublishButton } from "@/components/UnpublishButton";
```

(b) In the "My listings" section, the row currently renders:

```tsx
              <span className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wide text-zinc-400">{a.status}</span>
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
              </span>
```

Replace it with (adds the Unpublish control for live, un-bid rows):

```tsx
              <span className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wide text-zinc-400">{a.status}</span>
                {a.status === "draft" && <DiscardDraftButton auctionId={a.id} />}
                {a.status === "live" && a.current_bid == null && <UnpublishButton auctionId={a.id} />}
              </span>
```

- [ ] **Step 4: Verify it builds and typechecks**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 5: Verify the service client did not leak into a client module**

Run: `git grep -n "lib/supabase/service\|lib/listings/service" src/components`
Expected: no match. `UnpublishButton.tsx` must import only `@/app/dashboard/actions`.

- [ ] **Step 6: Commit**

```bash
git add src/components/UnpublishButton.tsx src/app/dashboard/page.tsx
git commit -m "Add UnpublishButton to live un-bid rows in the dashboard My listings"
```

---

## Task 4: End-to-end test + full suite green

**Files:**
- Create: `tests/e2e/unpublish.spec.ts`

**Interfaces:**
- Consumes: the running app (Playwright `webServer`); `global-setup.ts` resets the DB before the run; the seeded Toyota Hilux (`a06`, seller = dealer 1, live, no bids); the dashboard row markup (`div.flex.items-center.justify-between` with the vehicle label, the status, and the Unpublish/Discard buttons).
- Produces: an e2e spec that logs in as dealer 1, unpublishes the Hilux from the dashboard, and confirms the row became a draft.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/unpublish.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Uses the seeded Toyota Hilux (a06, seller = dealer 1, live, no bids). a06 is the SPARE
// auction no other e2e spec touches (a01 is bid on by bidding.spec, a02 by discovery/realtime,
// a03 sold by buy-now); unpublish permanently reverts it and globalSetup resets the DB only
// once, so this spec (alphabetically last) runs after all others.
test("seller unpublishes a live no-bid listing back to draft", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Auckland Motor Wholesale/ }).click(); // dealer 1 owns the Hilux
  await expect(page).toHaveURL("/");
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");

  // Scope to the Hilux row (a My-listings row div) and unpublish it (two-step confirm).
  const hiluxRow = page.locator("div.flex.items-center.justify-between", { hasText: "2017 Toyota Hilux" });
  await hiluxRow.getByRole("button", { name: "Unpublish" }).click();
  await hiluxRow.getByRole("button", { name: "Yes" }).click();

  // It reverted to a draft: the draft-only Discard control now appears and Unpublish is gone.
  await expect(hiluxRow.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(hiluxRow.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the e2e spec**

Ensure no stale dev server is on port 3000 (a degraded long-lived server flakes the realtime spec); if one is, stop it so Playwright starts a fresh one.

Run: `npx playwright test tests/e2e/unpublish.spec.ts`
Expected: PASS. If the Unpublish button isn't found, confirm `a06` is live with no bids in seed and that the dashboard gate is `a.status === "live" && a.current_bid == null`.

- [ ] **Step 3: Run the full integration suite**

Run: `npx supabase db reset && npm test`
Expected: all Vitest files PASS (Slices 1–6). If `db reset` transiently fails to recreate a container, re-run it, then `npm test`.

- [ ] **Step 4: Run the full e2e suite (fresh server, twice)**

Ensure port 3000 is clear so Playwright manages a fresh dev server.

Run: `npx playwright test` — expect bidding, buy-now, dashboard, discovery, realtime, unpublish green and listing skipped (R2). Run it a **second** time (fresh server) to confirm stability. If the realtime spec flakes on a reused/degraded server, clear port 3000 and re-run with a fresh one.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/unpublish.spec.ts
git commit -m "Add unpublish e2e covering revert of a live listing to draft"
```

---

## Self-Review

**Spec coverage (§ of `2026-07-05-slice6-seller-unpublish-design.md`):**
- §4 `unpublish_listing` (guards not_owner/not_live/has_bids, sets draft + start_time null, returns 'reverted', revoke-before-grant) → Task 1. ✅
- §5 `unpublishListing` service + `unpublishAction` (cookie identity, revalidate `/dashboard`+`/`+`/auction/[id]`, friendly messages) → Task 2. ✅
- §6 `UnpublishButton` (two-step confirm) + dashboard live-no-bid gate → Task 3. ✅
- §7 error handling (friendly messages, RPC as guardrail, cookie redirect) → Tasks 2, 3. ✅
- §8 integration (happy, not_owner, not_live, has_bids, relist round-trip, anon-denied) with own-fixture + cleanup + service test + e2e → Tasks 1, 2, 4. ✅
- §8 invariant (anon cannot execute; bid auction never reverts) → Task 1. ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `unpublishListing(dealerId, auctionId)` and `unpublishAction(_prev, formData)` signatures match across Tasks 2–3; RPC param names (`p_auction_id`, `p_dealer_id`) match between Task 1 SQL and Task 2 caller; `UnpublishButton({ auctionId })` prop matches its dashboard usage; the RPC reason strings (`not_owner`/`not_live`/`has_bids`) match the `UNPUBLISH_MESSAGES` keys; `createLiveAuction`/`deleteAuctions` signatures match between Task 1 (definition) and Tasks 1–2 (use). ✅

**Test-hygiene consistency:** both integration files build their own live auction via `createLiveAuction`, track ids, and `deleteAuctions` in `afterEach` — no seeded row is reverted to draft (which would leak past `test_reset`). The e2e uses seed `a06` but runs under globalSetup's single reset as the alphabetically-last spec, mutating a spare auction. ✅
