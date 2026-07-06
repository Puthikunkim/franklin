# Slice 7 — In-app Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a dealer when they were outbid, won an auction, sold a listing, or are watching an auction that's ending soon — via a header 🔔 with an unread badge and a `/notifications` page.

**Architecture:** A thin `notifications` event-log table holds `outbid`/`won`/`sold` rows, generated *inside* the existing SECURITY DEFINER writers (`place_bid`, `close_auction`, `buy_now_listing`) where the moment already occurs. "Ending soon" is derived on-read from the watchlist (no rows). A server-rendered `Header` badge and `/notifications` page read via the anon client; `mark_notifications_read` (service_role-only) clears the unread badge when the page is viewed.

**Tech Stack:** Next.js 16 (App Router, RSC, server components), Supabase local (Postgres + PostgREST), TypeScript, Vitest (integration vs local DB), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-06-slice7-notifications-design.md`
**Branch:** `feat/slice7-notifications` (already created; design committed at `6334ac3`).

## Global Constraints

- **Money:** integer cents everywhere. Fees are seeded defaults (`seller_fee` 20000, `buyer_fee` 2000).
- **Writer RPC security pattern:** any new writer RPC is `security definer set search_path = public`, and MUST `revoke execute ... from public, anon, authenticated;` **before** `grant execute ... to service_role;` (Postgres grants EXECUTE to PUBLIC by default). Applies to `mark_notifications_read`. `_notify` has its default PUBLIC execute revoked too (it is only called from within the definer writers).
- **Identity:** always from the httpOnly `dealer_id` cookie via `getDealerId()` — never client/form input.
- **Service client:** `serviceClient()` (`src/lib/supabase/service.ts`) is server-only; NEVER import it into a `"use client"` module.
- **DI pattern:** read functions take `(sb: SupabaseClient, dealerId: string)`; tests pass `admin`, pages pass `await serverClient()`.
- **Vitest:** shared single local DB, `fileParallelism: false`. New integration tests reset/clean their own state (`beforeEach(resetDb)`, `afterEach(deleteAuctions(...))`) and scope any global assertions to seeded ids.
- **Playwright:** `workers: 1`; run against a **fresh** dev server per full run (a stale long-lived dev server degrades `realtime.spec`). `listing.spec.ts` stays skipped (R2 deferred).
- **Ending-soon window:** 30 minutes (`ENDING_SOON_MINUTES = 30`).
- **Next.js 16:** before writing any route/page, read the relevant guide under `node_modules/next/dist/docs/`. `params`/`searchParams` are Promises — `await` them. `revalidatePath` from `next/cache`, `redirect` from `next/navigation`.
- **Commits:** single line, no co-author trailer. Work only on `feat/slice7-notifications` (never commit to `main`).
- **No credentials:** this slice adds none.

## File Structure

- **Create** `supabase/migrations/0009_notifications.sql` — the `notifications` table + index + grants; the `_notify` helper; the `mark_notifications_read` writer; a redefined `test_reset()`; and (appended in Task 2) the three writer functions re-created with `_notify` calls.
- **Modify** `tests/helpers/db.ts` — extend `deleteAuctions` to delete `notifications` referencing the auctions (FK does not cascade).
- **Create** `src/lib/notifications.ts` — reads (`listNotifications`, `getEndingSoonWatched`, `getUnreadCount`) + the `markNotificationsRead` service writer + `ENDING_SOON_MINUTES`.
- **Modify** `src/types/db.ts` — add `NotificationType` + `Notification`.
- **Modify** `src/components/Header.tsx` — add the 🔔 link + unread badge.
- **Create** `src/app/notifications/page.tsx` — the notifications page (ending-soon group + recent feed + mark-read-on-render).
- **Create tests:** `tests/notifications_rpc.test.ts` (Task 1), `tests/notifications_generation.test.ts` (Task 2), `tests/notifications_service.test.ts` (Task 3), `tests/e2e/notifications.spec.ts` (Task 5).

**Seed ids referenced (from `supabase/seed.sql`):** dealers D1 `11111111-1111-1111-1111-111111111111` (Auckland Motor Wholesale), D2 `22222222-2222-2222-2222-222222222222` (Waikato Trade Cars), D3 `33333333-3333-3333-3333-333333333333` (Capital Auto Traders), D5 `55555555-5555-5555-5555-555555555555` (BayCity). Auction a01 `a0000000-0000-0000-0000-000000000a01` (Toyota Corolla, live), a05 `a0000000-0000-0000-0000-000000000a05` (Nissan Leaf 2022, seller D5, live, ends +45min).

---

### Task 1: Notifications table, `_notify` helper, `mark_notifications_read` writer, `test_reset` update, and `deleteAuctions` extension

**Files:**
- Create: `supabase/migrations/0009_notifications.sql`
- Modify: `tests/helpers/db.ts` (extend `deleteAuctions`)
- Test: `tests/notifications_rpc.test.ts`

**Interfaces:**
- Produces (SQL): table `notifications(id, recipient_dealer_id, type, auction_id, created_at, read_at)`; `_notify(p_recipient uuid, p_type text, p_auction uuid) returns void`; `mark_notifications_read(p_dealer_id uuid) returns void` (service_role-only); redefined `test_reset()` that also `truncate notifications`.
- Produces (TS): `deleteAuctions(ids)` also deletes `notifications` referencing those auctions.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0009_notifications.sql`:

```sql
-- Slice 7: in-app notifications. A thin event log of things a dealer would want to know
-- about but may not be looking at: they were outbid, they won, their listing sold. Rows are
-- generated inside the existing writer RPCs (place_bid / close_auction / buy_now_listing) —
-- see the create-or-replace block appended below. "Ending soon" is derived on-read from the
-- watchlist (no rows here).

create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_dealer_id uuid not null references dealers(id),
  type text not null check (type in ('outbid','won','sold')),
  auction_id uuid not null references auctions(id),
  created_at timestamptz not null default now(),
  read_at timestamptz            -- null = unread
);
create index on notifications (recipient_dealer_id, created_at desc);

-- Reads are dealer-scoped in the query (same no-RLS demo trust model as auctions/bids).
-- Only the SECURITY DEFINER writers (running as owner) and service_role (tests) write rows.
grant select on notifications to anon, authenticated;
grant select, insert, update, delete on notifications to service_role;

-- Internal helper: insert one notification. Only ever called from within the SECURITY DEFINER
-- writers (which run as owner and always retain execute), so its default PUBLIC execute grant
-- is revoked — no external caller can forge a row (and anon has no INSERT on the table anyway).
create or replace function _notify(p_recipient uuid, p_type text, p_auction uuid)
returns void language sql as $$
  insert into notifications (recipient_dealer_id, type, auction_id)
  values (p_recipient, p_type, p_auction);
$$;
revoke execute on function _notify(uuid, text, uuid) from public, anon, authenticated;

-- Mark all of a dealer's unread notifications read. Writer: service_role-only (the browser
-- anon key must never reach it); dealer identity comes from the httpOnly cookie in the action.
create or replace function mark_notifications_read(p_dealer_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update notifications set read_at = now()
   where recipient_dealer_id = p_dealer_id and read_at is null;
end;
$$;
revoke execute on function mark_notifications_read(uuid) from public, anon, authenticated;
grant execute on function mark_notifications_read(uuid) to service_role;

-- Redefine test_reset to also clear notifications so integration tests stay isolated (a
-- notification generated by one test must not leak into the next). Preserves the 0006 change
-- that scopes the auction reset to non-draft rows (drafts keep their identity across resets).
create or replace function test_reset() returns void language plpgsql security definer as $$
begin
  truncate bids restart identity cascade;
  truncate settlements restart identity cascade;
  truncate notifications restart identity cascade;
  update auctions
    set current_bid = null,
        current_winner_dealer_id = null,
        status = 'live',
        end_time = now() + interval '2 hours'
  where status <> 'draft';
end;
$$;
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db reset`
Expected: reset completes, applying migrations `0001`…`0009` and the seed with no errors.

- [ ] **Step 3: Extend `deleteAuctions` to delete notifications**

In `tests/helpers/db.ts`, inside `deleteAuctions`, add the notifications delete alongside bids/settlements (before the auctions delete). Replace the delete block:

```ts
  await admin.from("bids").delete().in("auction_id", ids);
  await admin.from("settlements").delete().in("auction_id", ids);
  await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
```

with:

```ts
  await admin.from("bids").delete().in("auction_id", ids);
  await admin.from("settlements").delete().in("auction_id", ids);
  await admin.from("notifications").delete().in("auction_id", ids);
  await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
```

Also update the comment above the function to mention notifications (the FK does not cascade).

- [ ] **Step 4: Write the failing test**

Create `tests/notifications_rpc.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, anon, resetDb } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const A01 = "a0000000-0000-0000-0000-000000000a01"; // seeded live auction (read-only here)

async function insertNotif(recipient: string, type: string) {
  const { error } = await admin.from("notifications").insert({
    recipient_dealer_id: recipient, type, auction_id: A01,
  });
  if (error) throw error;
}

describe("notifications storage + mark_notifications_read", () => {
  beforeEach(resetDb); // truncates notifications between cases

  it("marks the dealer's unread rows read and leaves other dealers' rows", async () => {
    await insertNotif(D1, "outbid");
    await insertNotif(D1, "won");
    await insertNotif(D2, "sold");

    const { error } = await admin.rpc("mark_notifications_read", { p_dealer_id: D1 });
    expect(error).toBeNull();

    const { data: d1rows } = await admin
      .from("notifications").select("read_at").eq("recipient_dealer_id", D1);
    expect(d1rows!.length).toBe(2);
    expect(d1rows!.every((r) => r.read_at !== null)).toBe(true);

    const { data: d2rows } = await admin
      .from("notifications").select("read_at").eq("recipient_dealer_id", D2);
    expect(d2rows![0].read_at).toBeNull();
  });

  it("forbids the anon (browser) role from executing mark_notifications_read", async () => {
    const { error } = await anon.rpc("mark_notifications_read", { p_dealer_id: D1 });
    expect(error).not.toBeNull();
  });

  it("forbids the anon role from inserting a forged notification", async () => {
    const { error } = await anon.from("notifications").insert({
      recipient_dealer_id: D1, type: "won", auction_id: A01,
    });
    expect(error).not.toBeNull();
  });

  it("forbids the anon role from executing the _notify helper", async () => {
    const { error } = await anon.rpc("_notify", {
      p_recipient: D1, p_type: "won", p_auction: A01,
    });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/notifications_rpc.test.ts`
Expected: PASS (4 tests). If the migration was applied in Step 2, the table + RPC exist; the anon cases error as intended.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0009_notifications.sql tests/helpers/db.ts tests/notifications_rpc.test.ts
git commit -m "Add notifications table, mark_notifications_read RPC, and test_reset/cleanup wiring"
```

---

### Task 2: Generate `outbid`/`won`/`sold` rows inside the writer RPCs

**Files:**
- Modify: `supabase/migrations/0009_notifications.sql` (append three `create or replace function` blocks)
- Test: `tests/notifications_generation.test.ts`

**Interfaces:**
- Consumes: `_notify(uuid, text, uuid)` from Task 1.
- Produces (behavioral): `place_bid` inserts `outbid` for the displaced leader on a lead change; `close_auction` inserts `won`+`sold` on a reserve-met close; `buy_now_listing` inserts `sold` for the seller.

- [ ] **Step 1: Write the failing test**

Create `tests/notifications_generation.test.ts`. It builds its own live fixtures (seller = D3, so the two bidders D1/D2 are never the seller) and cleans them up:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333"; // fixture seller (never a bidder)

const created: string[] = [];
async function makeLive(): Promise<string> {
  const id = await createLiveAuction(D3); // Kia Sportage: starting 1,000,000 / reserve 1,200,000 / buy_now 1,500,000
  created.push(id);
  return id;
}
async function bid(auction: string, dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", {
    p_auction_id: auction, p_dealer_id: dealer, p_max_amount: max,
  });
  if (error) throw error;
}
async function notifs(recipient: string, type?: string) {
  let q = admin.from("notifications").select("type, auction_id").eq("recipient_dealer_id", recipient);
  if (type) q = q.eq("type", type);
  const { data } = await q;
  return data ?? [];
}

describe("notification generation in the writer RPCs", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("place_bid notifies the displaced leader when the lead changes", async () => {
    const id = await makeLive();
    await bid(id, D1, 1100000);          // D1 leads at the 1,000,000 starting price
    await bid(id, D2, 1300000);          // D2's max beats D1's proxy → D2 wins, D1 displaced
    const d1 = await notifs(D1, "outbid");
    expect(d1.length).toBe(1);
    expect(d1[0].auction_id).toBe(id);
    expect((await notifs(D2)).length).toBe(0); // the new leader is not notified
  });

  it("place_bid does NOT notify on a self-raise", async () => {
    const id = await makeLive();
    await bid(id, D1, 1100000);          // D1 leads
    await bid(id, D1, 1400000);          // D1 raises their own proxy
    expect((await notifs(D1, "outbid")).length).toBe(0);
  });

  it("place_bid does NOT create an outbid row when the leader's proxy holds", async () => {
    const id = await makeLive();
    await bid(id, D1, 1300000);          // D1 leads with a high proxy
    await bid(id, D2, 1250000);          // below D1's proxy → D1 holds the lead
    expect((await notifs(D1, "outbid")).length).toBe(0);
    expect((await notifs(D2, "outbid")).length).toBe(0);
  });

  it("close_auction notifies the winner (won) and the seller (sold) on a sold close", async () => {
    const id = await makeLive();
    await bid(id, D1, 1300000);          // D1 leads
    await bid(id, D2, 1250000);          // proxy holds → price rises to 1,275,000 (>= reserve), no outbid row
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const { data: status } = await admin.rpc("close_auction", { p_auction_id: id });
    expect(status).toBe("sold");
    expect((await notifs(D1, "won")).length).toBe(1);   // D1 is the winner
    expect((await notifs(D3, "sold")).length).toBe(1);  // D3 is the seller
  });

  it("close_auction creates no notifications on a passed (reserve-not-met) close", async () => {
    const id = await makeLive();
    await bid(id, D1, 1100000);          // single bid sits at 1,000,000 < reserve 1,200,000
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
    const { data: status } = await admin.rpc("close_auction", { p_auction_id: id });
    expect(status).toBe("passed");
    expect((await notifs(D1)).length).toBe(0);
    expect((await notifs(D3)).length).toBe(0);
  });

  it("buy_now_listing notifies the seller (sold) and not the buyer", async () => {
    const id = await makeLive();
    const { data: result } = await admin.rpc("buy_now_listing", {
      p_auction_id: id, p_buyer_dealer_id: D1,
    });
    expect(result).toBe("bought");
    expect((await notifs(D3, "sold")).length).toBe(1); // seller
    expect((await notifs(D1)).length).toBe(0);         // buyer gets nothing (already redirected to /won)
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/notifications_generation.test.ts`
Expected: FAIL — the writers don't insert notifications yet (e.g. `expected 1 to be 0` / `expected 0 to be 1`).

- [ ] **Step 3: Append the writer redefinitions to the migration**

Append to `supabase/migrations/0009_notifications.sql` (full function bodies reproduced from `0002`/`0003`/`0007` with the `_notify` calls added):

```sql
-- ── Generation: re-create the writers with notification inserts (additive only) ──────────────

-- place_bid: notify the displaced leader when the lead changes hands.
create or replace function place_bid(
  p_auction_id  uuid,
  p_dealer_id   uuid,
  p_max_amount  int
)
returns table (
  status                    text,
  reason                    text,
  current_bid               int,
  current_winner_dealer_id  uuid,
  end_time                  timestamptz
)
language plpgsql security definer
set search_path = public as $$
declare
  a             auctions%rowtype;
  v_min         int;
  v_leader_max  int;
  v_new_price   int;
  v_new_winner  uuid;
begin
  select * into a from auctions where id = p_auction_id for update;

  if a.status <> 'live' or a.end_time <= now() then
    return query select 'rejected'::text, 'auction_ended'::text,
      a.current_bid, a.current_winner_dealer_id, a.end_time;
    return;
  end if;

  if a.current_bid is null then
    v_min := a.starting_price;
  else
    v_min := a.current_bid + a.bid_increment;
  end if;

  if p_max_amount < v_min then
    return query select 'rejected'::text, 'below_minimum'::text,
      a.current_bid, a.current_winner_dealer_id, a.end_time;
    return;
  end if;

  select max(max_amount) into v_leader_max
    from bids
   where auction_id = p_auction_id
     and bidder_dealer_id = a.current_winner_dealer_id;

  if a.current_winner_dealer_id is null then
    v_new_price  := a.starting_price;
    v_new_winner := p_dealer_id;

  elsif p_dealer_id = a.current_winner_dealer_id then
    v_new_price  := a.current_bid;
    v_new_winner := p_dealer_id;

  elsif p_max_amount > coalesce(v_leader_max, a.current_bid) then
    v_new_price  := least(coalesce(v_leader_max, a.current_bid) + a.bid_increment, p_max_amount);
    v_new_winner := p_dealer_id;
    -- The previous leader just lost the lead: notify them they were outbid.
    perform _notify(a.current_winner_dealer_id, 'outbid', p_auction_id);

  else
    v_new_price  := least(p_max_amount + a.bid_increment, v_leader_max);
    v_new_winner := a.current_winner_dealer_id;
  end if;

  insert into bids (auction_id, bidder_dealer_id, amount, max_amount)
    values (p_auction_id, p_dealer_id, v_new_price, p_max_amount);

  if a.end_time - now() <= make_interval(secs => a.anti_snipe_seconds) then
    a.end_time := a.end_time + make_interval(secs => a.anti_snipe_seconds);
  end if;

  update auctions
     set current_bid              = v_new_price,
         current_winner_dealer_id = v_new_winner,
         end_time                 = a.end_time
   where id = p_auction_id;

  return query select 'accepted'::text, null::text, v_new_price, v_new_winner, a.end_time;
end;
$$;

-- close_auction: notify the winner (won) and the seller (sold) on a reserve-met close.
create or replace function close_auction(p_auction_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if a.status <> 'live' then return a.status; end if;
  if a.end_time > now() then return 'live'; end if;
  if a.current_bid is not null and a.current_bid >= a.reserve_price then
    update auctions set status = 'sold' where id = p_auction_id;
    insert into settlements (auction_id, sale_price)
      values (p_auction_id, a.current_bid)
      on conflict (auction_id) do nothing;
    perform _notify(a.current_winner_dealer_id, 'won', p_auction_id);
    perform _notify(a.seller_dealer_id, 'sold', p_auction_id);
    return 'sold';
  else
    update auctions set status = 'passed' where id = p_auction_id;
    return 'passed';
  end if;
end;
$$;

-- buy_now_listing: notify the seller (sold). The buyer is the actor (redirected to /won).
create or replace function buy_now_listing(p_auction_id uuid, p_buyer_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found then return 'not_found'; end if;
  if a.status <> 'live' then return a.status; end if;
  if a.buy_now_price is null then return 'no_buy_now'; end if;
  if a.current_bid is not null then return 'has_bids'; end if;
  if a.seller_dealer_id = p_buyer_dealer_id then return 'is_seller'; end if;

  update auctions
     set status = 'sold',
         current_bid = a.buy_now_price,
         current_winner_dealer_id = p_buyer_dealer_id,
         end_time = now()
   where id = p_auction_id;

  insert into settlements (auction_id, sale_price)
     values (p_auction_id, a.buy_now_price)
     on conflict (auction_id) do nothing;
  perform _notify(a.seller_dealer_id, 'sold', p_auction_id);
  return 'bought';
end; $$;
```

- [ ] **Step 4: Apply the migration and run the test**

Run: `npx supabase db reset && npx vitest run tests/notifications_generation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify the existing bid/close/buy suites still pass (no regressions)**

Run: `npx vitest run tests/place_bid.test.ts tests/buy_now.test.ts tests/dashboard.test.ts`
Expected: PASS — the additions are behavior-preserving for the existing return values.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0009_notifications.sql tests/notifications_generation.test.ts
git commit -m "Generate outbid/won/sold notifications inside place_bid, close_auction, and buy_now_listing"
```

---

### Task 3: Notifications read/derive library + mark-read service

**Files:**
- Create: `src/lib/notifications.ts`
- Test: `tests/notifications_service.test.ts`

**Interfaces:**
- Consumes: `notifications` table, `watchlist`/`auctions`/`vehicles` (reads); `mark_notifications_read` RPC; `serviceClient()`; `test_set_end_in_seconds` (tests).
- Produces:
  - `ENDING_SOON_MINUTES: number` (= 30)
  - `listNotifications(sb, dealerId): Promise<any[]>` — stored rows newest-first, each with `auction.vehicle` embedded.
  - `getEndingSoonWatched(sb, dealerId): Promise<any[]>` — watched auctions that are `live` and ending within the window, ending-soonest first, each with `vehicle` embedded.
  - `getUnreadCount(sb, dealerId): Promise<number>` — unread stored rows + ending-soon count.
  - `markNotificationsRead(dealerId): Promise<void>` — service-role writer.

- [ ] **Step 1: Write the failing test**

Create `tests/notifications_service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";
import {
  listNotifications, getEndingSoonWatched, getUnreadCount, ENDING_SOON_MINUTES,
} from "@/lib/notifications";

const D1 = "11111111-1111-1111-1111-111111111111";
const D3 = "33333333-3333-3333-3333-333333333333";

const created: string[] = [];
async function makeLive(seller = D3): Promise<string> {
  const id = await createLiveAuction(seller);
  created.push(id);
  return id;
}
async function watch(dealer: string, auction: string) {
  const { error } = await admin.from("watchlist").insert({ dealer_id: dealer, auction_id: auction });
  if (error) throw error;
}
async function insertNotif(recipient: string, type: string, auction: string) {
  const { error } = await admin.from("notifications").insert({
    recipient_dealer_id: recipient, type, auction_id: auction,
  });
  if (error) throw error;
}

describe("notifications library", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("ENDING_SOON_MINUTES is 30", () => {
    expect(ENDING_SOON_MINUTES).toBe(30);
  });

  it("getEndingSoonWatched returns only watched, live, in-window auctions", async () => {
    const soon = await makeLive();     // will be nudged into the window and watched
    const later = await makeLive();    // watched but ends far in the future (default +2 days)
    const unwatched = await makeLive(); // in window but not watched
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: soon, p_seconds: 600 });      // 10 min
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: unwatched, p_seconds: 600 });
    await watch(D1, soon);
    await watch(D1, later);

    const rows = await getEndingSoonWatched(admin, D1);
    const ids = rows.map((a) => a.id);
    expect(ids).toContain(soon);
    expect(ids).not.toContain(later);      // out of window
    expect(ids).not.toContain(unwatched);  // not watched
    expect(rows[0].vehicle).toBeTruthy();  // vehicle is embedded
  });

  it("listNotifications returns the dealer's rows newest-first with the auction embedded", async () => {
    const id = await makeLive();
    await insertNotif(D1, "outbid", id);
    await insertNotif(D1, "won", id);
    const rows = await listNotifications(admin, D1);
    expect(rows.length).toBe(2);
    expect(new Date(rows[0].created_at).getTime())
      .toBeGreaterThanOrEqual(new Date(rows[1].created_at).getTime());
    expect(rows[0].auction.vehicle).toBeTruthy();
    expect(rows[0].read_at).toBeNull();
  });

  it("getUnreadCount sums unread stored rows and ending-soon watched auctions", async () => {
    const soon = await makeLive();
    const other = await makeLive();
    await admin.rpc("test_set_end_in_seconds", { p_auction_id: soon, p_seconds: 600 });
    await watch(D1, soon);                 // +1 ending-soon
    await insertNotif(D1, "outbid", other); // +1 unread stored
    await insertNotif(D1, "won", other);    // +1 unread stored
    expect(await getUnreadCount(admin, D1)).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/notifications_service.test.ts`
Expected: FAIL — `@/lib/notifications` does not exist yet.

- [ ] **Step 3: Write the library**

Create `src/lib/notifications.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";

export const ENDING_SOON_MINUTES = 30;

// A dealer's stored notifications (outbid/won/sold), newest first, each joined to its
// auction + vehicle for rendering. Read via the caller's client (anon on the page).
export async function listNotifications(sb: SupabaseClient, dealerId: string): Promise<any[]> {
  const { data } = await sb
    .from("notifications")
    .select("*, auction:auctions(*, vehicle:vehicles(*))")
    .eq("recipient_dealer_id", dealerId)
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}

// The dealer's watched auctions that are still live and end within the next N minutes,
// ending-soonest first. Derived on-read — no stored rows, no scheduler. Filtered in JS
// (a dealer watches only a handful) rather than via embedded-resource filters.
export async function getEndingSoonWatched(sb: SupabaseClient, dealerId: string): Promise<any[]> {
  const now = Date.now();
  const soon = now + ENDING_SOON_MINUTES * 60000;
  const { data } = await sb
    .from("watchlist")
    .select("auction:auctions(*, vehicle:vehicles(*))")
    .eq("dealer_id", dealerId);
  return (data ?? [])
    .map((r: { auction: any }) => r.auction)
    .filter((a: any) => a && a.status === "live")
    .filter((a: any) => {
      const t = new Date(a.end_time).getTime();
      return t > now && t <= soon;
    })
    .sort((a: any, b: any) => new Date(a.end_time).getTime() - new Date(b.end_time).getTime());
}

// Badge count: unread stored notifications + watched auctions currently ending soon.
export async function getUnreadCount(sb: SupabaseClient, dealerId: string): Promise<number> {
  const { count } = await sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_dealer_id", dealerId)
    .is("read_at", null);
  const endingSoon = await getEndingSoonWatched(sb, dealerId);
  return (count ?? 0) + endingSoon.length;
}

// Writer: mark all of the dealer's unread notifications read. service_role-only (server).
export async function markNotificationsRead(dealerId: string): Promise<void> {
  await serviceClient().rpc("mark_notifications_read", { p_dealer_id: dealerId });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/notifications_service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications.ts tests/notifications_service.test.ts
git commit -m "Add notifications read library (list, ending-soon, unread count) and mark-read service"
```

---

### Task 4: Header 🔔 badge + `/notifications` page

**Files:**
- Modify: `src/types/db.ts` (add `NotificationType` + `Notification`)
- Modify: `src/components/Header.tsx` (🔔 link + unread badge)
- Create: `src/app/notifications/page.tsx`

**Interfaces:**
- Consumes: `getUnreadCount`, `listNotifications`, `getEndingSoonWatched`, `markNotificationsRead` from `@/lib/notifications`; `serverClient`; `getDealerId`; `formatNZD`; `Header`.
- Produces: the header badge with accessible name `Notifications` (or `Notifications (N unread)` when `N > 0`); a `/notifications` route.

- [ ] **Step 1: Read the Next.js page guide**

Before writing the route, read the App Router page/rendering guide under `node_modules/next/dist/docs/` (async server components, dynamic rendering via `cookies()`). Confirm the mutation-during-render pattern is consistent with `src/app/won/[id]/page.tsx` (which calls `close_auction` during render).

- [ ] **Step 2: Add the notification types**

Append to `src/types/db.ts`:

```ts
export type NotificationType = "outbid" | "won" | "sold";
export interface Notification {
  id: string; recipient_dealer_id: string; type: NotificationType;
  auction_id: string; created_at: string; read_at: string | null;
}
```

- [ ] **Step 3: Add the 🔔 to the Header**

Replace `src/components/Header.tsx` with:

```tsx
import Link from "next/link";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { getUnreadCount } from "@/lib/notifications";

export async function Header() {
  const dealerId = await getDealerId();
  let unread = 0;
  if (dealerId) {
    const sb = await serverClient();
    unread = await getUnreadCount(sb, dealerId);
  }
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <Link href="/" className="font-semibold text-white">Wholesale Dealer Auctions</Link>
      {dealerId && (
        <nav className="flex items-center gap-2">
          <Link
            href="/notifications"
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            className="relative rounded px-3 py-1.5 text-sm font-medium text-zinc-200 hover:text-white"
          >
            <span aria-hidden="true">🔔</span>
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                {unread}
              </span>
            )}
          </Link>
          <Link href="/dashboard" className="rounded px-3 py-1.5 text-sm font-medium text-zinc-200 hover:text-white">
            Dashboard
          </Link>
          <Link href="/sell" className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
            Sell a vehicle
          </Link>
        </nav>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Create the notifications page**

Create `src/app/notifications/page.tsx`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";
import { formatNZD } from "@/lib/money";
import { Header } from "@/components/Header";
import { listNotifications, getEndingSoonWatched, markNotificationsRead } from "@/lib/notifications";

function vehicleLabel(v: { year: number; make: string; model: string }) {
  return `${v.year} ${v.make} ${v.model}`;
}

const LABEL: Record<string, (v: string) => string> = {
  outbid: (v) => `You were outbid on ${v}`,
  won: (v) => `You won ${v}`,
  sold: (v) => `Your ${v} sold`,
};

function hrefFor(type: string, auctionId: string): string {
  return type === "won" ? `/won/${auctionId}` : `/auction/${auctionId}`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function NotificationsPage() {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const sb = await serverClient();

  const [rows, endingSoon] = await Promise.all([
    listNotifications(sb, dealerId),
    getEndingSoonWatched(sb, dealerId),
  ]);
  // Capture which rows were unread THIS visit (for the "New" highlight) before clearing.
  const wasUnread = new Set(rows.filter((r: any) => r.read_at == null).map((r: any) => r.id));
  // Clear the unread badge for next time — mutation during render, same pattern /won uses.
  await markNotificationsRead(dealerId);

  const rowClass = "flex items-center justify-between rounded border px-4 py-3";

  return (
    <>
      <Header />
      <main className="mx-auto max-w-2xl px-6 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-white">Notifications</h1>

        {endingSoon.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Ending soon</h2>
            {endingSoon.map((a: any) => (
              <Link key={a.id} href={`/auction/${a.id}`} className={`${rowClass} border-amber-700 bg-amber-950/30`}>
                <span className="text-white">{vehicleLabel(a.vehicle)}</span>
                <span className="font-mono text-amber-300">{formatNZD(a.current_bid ?? a.starting_price)}</span>
              </Link>
            ))}
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Recent</h2>
          {rows.length === 0 && endingSoon.length === 0 && (
            <p className="text-zinc-500">You have no notifications yet.</p>
          )}
          {rows.map((r: any) => {
            const label = (LABEL[r.type] ?? ((v: string) => v))(vehicleLabel(r.auction.vehicle));
            const isNew = wasUnread.has(r.id);
            return (
              <Link
                key={r.id}
                href={hrefFor(r.type, r.auction_id)}
                className={`${rowClass} ${isNew ? "border-emerald-700 bg-emerald-950/20" : "border-zinc-800 bg-zinc-900/50"}`}
              >
                <span className="text-white">{label}</span>
                <span className="flex items-center gap-3">
                  {isNew && <span className="text-[10px] uppercase tracking-wide text-emerald-400">New</span>}
                  <span className="text-xs text-zinc-500">{timeAgo(r.created_at)}</span>
                </span>
              </Link>
            );
          })}
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; the build compiles `/notifications`.

- [ ] **Step 6: Verify no client component imports the server-only library**

Run: `git grep -n "@/lib/notifications" -- 'src/**/*.tsx' 'src/**/*.ts'`
Expected: only server files (`src/components/Header.tsx`, `src/app/notifications/page.tsx`) — none with `"use client"` at the top. (`src/lib/notifications.ts` imports `serviceClient`, which must never reach a client bundle.)

- [ ] **Step 7: Commit**

```bash
git add src/types/db.ts src/components/Header.tsx src/app/notifications/page.tsx
git commit -m "Add header notification bell with unread badge and the /notifications page"
```

---

### Task 5: e2e outbid flow + full green

**Files:**
- Create: `tests/e2e/notifications.spec.ts`

**Interfaces:**
- Consumes: the running app + a fresh DB (Playwright `globalSetup` resets once). Uses the SPARE seeded auction a05 (Nissan Leaf, seller D5) — untouched by a01 (bidding), a02 (discovery/realtime), a03 (buy-now), a06 (unpublish).

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/notifications.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";

// Two-dealer outbid on the SPARE seeded Nissan Leaf (a05, seller = BayCity / dealer 5). No
// other e2e spec touches a05, and globalSetup resets the DB only once. Dealer 1 (Auckland)
// takes the lead, dealer 2 (Waikato) outbids → dealer 1 gets a stored 'outbid' notification.
// Before this spec runs, dealer 1 has zero notifications (bidding uses a01, buy-now's sold
// goes to a03's seller D3, discovery/dashboard create none), so the badge is deterministically 1.
const LEAF = "/auction/a0000000-0000-0000-0000-000000000a05";

async function loginAs(page: Page, dealerName: RegExp) {
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
}

async function placeBid(page: Page, dollars: string) {
  await page.goto(LEAF);
  await page.getByLabel("Your max bid (NZD $)").fill(dollars);
  await page.getByRole("button", { name: "Place bid" }).click();
  await expect(page.getByText("Bid placed successfully.")).toBeVisible();
}

test("an outbid dealer is notified, and viewing notifications clears the badge", async ({ page }) => {
  // Dealer 1 leads (max $15,000; opens at the $14,000 starting price).
  await loginAs(page, /Auckland Motor Wholesale/);
  await placeBid(page, "15000");

  // Dealer 2 outbids with a higher max, displacing dealer 1.
  await loginAs(page, /Waikato Trade Cars/);
  await placeBid(page, "16000");

  // Back as dealer 1: the header shows a single unread notification.
  await loginAs(page, /Auckland Motor Wholesale/);
  await expect(page.getByRole("link", { name: "Notifications (1 unread)" })).toBeVisible();

  // Let the home page's background Link prefetch settle before navigating (Next dev race
  // guard, as in dashboard.spec/unpublish.spec).
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /Notifications/ }).click();
  // First hit to /notifications compiles the route on demand in dev (cold) — allow extra time.
  await expect(page).toHaveURL("/notifications", { timeout: 20000 });
  await expect(page.getByText("You were outbid on 2022 Nissan Leaf")).toBeVisible({ timeout: 20000 });

  // Viewing marked it read: on the next navigation the unread badge is gone.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /unread/ })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the full vitest suite (with a clean DB) — everything green**

Run: `npx supabase db reset && npm test`
Expected: all test files pass, including the three new notifications files. (The reset applies migration `0009`; the suite is sequential.)

- [ ] **Step 3: Run the full Playwright suite against a fresh dev server**

Ensure nothing is already bound to port 3000 (kill any stale `next dev`), then run:

Run: `npm run test:e2e`
Expected: all specs pass (`notifications.spec.ts` included), `listing.spec.ts` skipped. Playwright manages a fresh dev server and runs `globalSetup` (one DB reset) first.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/notifications.spec.ts
git commit -m "Add e2e covering the outbid notification and badge-clear-on-view"
```

---

## Self-Review

**1. Spec coverage:**
- §4 data model → Task 1 (table, index, checked `type`, `read_at`). ✓
- §5 generation (`_notify` + place_bid/close_auction/buy_now) → Task 1 (`_notify` + revoke) & Task 2 (three writers, displaced-leader/won+sold/seller-sold rules, none on self-raise/proxy-hold/passed, no buyer `won`). ✓
- §6 reads + ending-soon → Task 3 (`listNotifications`, `getEndingSoonWatched`, `getUnreadCount`, `ENDING_SOON_MINUTES=30`). ✓
- §7 mark-read RPC + service → Task 1 (RPC, revoke-before-grant) & Task 3 (`markNotificationsRead`). ✓
- §8 UI (Header badge + `/notifications` page, ending-soon group, recent feed, unread highlight, mark-read-on-render, labels/hrefs) → Task 4. ✓
- §9 security (anon select, no anon DML, definer-only writes, `_notify` revoke) → Task 1 migration + Task 1 anon-denial tests + Task 4 boundary grep. ✓
- §11 testing (integration generation/mark-read/lib + e2e outbid on spare auction) → Tasks 1–3 + Task 5. ✓
- §3 badge includes ending-soon → `getUnreadCount` sums both (Task 3), covered by its test. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete content; the e2e spare auction is pinned to a05 with the reasoning inline. ✓

**3. Type consistency:** `_notify(uuid, text, uuid)`, `mark_notifications_read(uuid)` used identically in migration, tests, and service. `getEndingSoonWatched`/`listNotifications`/`getUnreadCount`/`markNotificationsRead` names match between `src/lib/notifications.ts`, its tests, and `Header`/page consumers. `recipient_dealer_id`/`read_at`/`auction_id`/`type` column names consistent across table, RPC, tests, and reads. The header accessible-name strings (`Notifications` / `Notifications (N unread)`) match the e2e locators. ✓

**Note on badge on the `/notifications` render:** `Header` computes `getUnreadCount` independently of the page's `markNotificationsRead`, so on the notifications page itself the badge may still show the pre-clear count within that one render; it fully reflects the cleared state on the next navigation — which is exactly what the e2e asserts (`page.goto("/")` then badge gone).
