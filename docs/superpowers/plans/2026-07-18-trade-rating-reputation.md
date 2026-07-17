# Trade Rating / Reputation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Franklin's fake static dealer rating with a real, earned reputation built from bidirectional, blind-reveal ratings left after each completed sale.

**Architecture:** One `ratings` table is the single source of truth. A `security definer` writer (`submit_rating`) records rows; three `security definer` reader functions compute visibility and averages on read (no sweep, no denormalized columns). A rating is visible only when both parties have rated or 14 days have passed since settlement, so the raw table is never granted to the browser role. UI surfaces (auction rate panel, dealer profile, auction-card badge) consume the readers through a thin `src/lib/ratings.ts`.

**Tech Stack:** Next.js 16 / React 19 (App Router, Server Components + Server Actions), Supabase Postgres (PL/pgSQL RPCs), Tailwind v4, Vitest (RPC + lib), Playwright (e2e).

## Global Constraints

- All money is integer cents. Rating scores are integers 1–5. Comments are `<= 280` chars, stored trimmed, empty-to-null.
- Every writer RPC is `security definer`, `set search_path = public`, `revoke execute ... from public, anon, authenticated`, `grant execute ... to service_role`. Dealer identity always comes from the httpOnly `dealer_id` cookie in a server action, never the browser.
- The `ratings` table is **never** granted to `anon`/`authenticated` (blind-safety). All reads go through the `security definer` reader functions, which ARE granted `execute` to `anon, authenticated`.
- Visibility rule, applied identically everywhere: a rating is visible when its auction has two ratings (both parties submitted), **or** `settlement.created_at + interval '14 days' <= now()`.
- `0012_ratings.sql` is a **single** migration built up across Tasks 1–4. Because the repo applies migrations by re-running everything (`npx supabase db reset` re-runs all migrations then `seed.sql`), each DB task **appends** to that one file and re-runs `db reset`. This is safe: the branch is unmerged and nothing has shipped.
- Commit messages must **not** contain a `Co-Authored-By` trailer (repo rule).
- This Next.js is non-standard: before using an unfamiliar Next API, read the relevant guide under `node_modules/next/dist/docs/` (per `AGENTS.md`).
- Tailwind theme tokens already in use: `ink`, `panel`, `panel-2`, `line`, `chalk`, `fog`, `signal` (accent), `go` (green), `stop` (red). Match them; do not introduce new colours.
- **Prerequisite for running any test:** local Supabase must be up (`npx supabase start`). Vitest hits `http://127.0.0.1:54321`; Playwright's global setup runs `npx supabase db reset` itself.

---

### Task 1: Ratings table + `submit_rating` writer

**Files:**
- Create: `supabase/migrations/0012_ratings.sql`
- Modify: `tests/helpers/db.ts` (add `createSoldAuction`; delete ratings in `deleteAuctions`)
- Test: `tests/ratings.test.ts`

**Interfaces:**
- Produces (SQL RPC): `submit_rating(p_auction_id uuid, p_rater_dealer_id uuid, p_score int, p_comment text) returns text`. Result codes: `ok | not_sold | not_party | window_closed | already_rated | bad_score`.
- Produces (SQL RPC, test-only): `test_set_settlement_age(p_auction_id uuid, p_seconds int) returns void` — sets a settlement's `created_at` to `now() - p_seconds`.
- Produces (test helper): `createSoldAuction(seller: string, buyer: string): Promise<string>` — a sold auction (buyer won above reserve), returns its id.

- [ ] **Step 1: Write the failing test**

Create `tests/ratings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, createSoldAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111"; // buyer
const D2 = "22222222-2222-2222-2222-222222222222"; // uninvolved dealer
const D3 = "33333333-3333-3333-3333-333333333333"; // seller

const created: string[] = [];
async function makeSold(seller = D3, buyer = D1): Promise<string> {
  const id = await createSoldAuction(seller, buyer);
  created.push(id);
  return id;
}
async function submit(auction: string, rater: string, score: number, comment: string | null = null) {
  const { data, error } = await admin.rpc("submit_rating", {
    p_auction_id: auction, p_rater_dealer_id: rater, p_score: score, p_comment: comment,
  });
  if (error) throw error;
  return data as string;
}

describe("submit_rating", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("records a buyer's rating of the seller with direction 'seller'", async () => {
    const id = await makeSold();
    expect(await submit(id, D1, 5, "  Exactly as graded  ")).toBe("ok");
    const { data: rows } = await admin.from("ratings").select("*").eq("auction_id", id);
    expect(rows).toHaveLength(1);
    expect(rows![0].ratee_dealer_id).toBe(D3);
    expect(rows![0].direction).toBe("seller");
    expect(rows![0].score).toBe(5);
    expect(rows![0].comment).toBe("Exactly as graded"); // trimmed
  });

  it("records a seller's rating of the buyer with direction 'buyer'", async () => {
    const id = await makeSold();
    expect(await submit(id, D3, 4)).toBe("ok");
    const { data: rows } = await admin.from("ratings").select("*").eq("auction_id", id);
    expect(rows![0].ratee_dealer_id).toBe(D1);
    expect(rows![0].direction).toBe("buyer");
    expect(rows![0].comment).toBeNull(); // empty/omitted comment stored as null
  });

  it("rejects a rating on an auction that is not sold", async () => {
    const live = await createLiveAuction(D3);
    created.push(live);
    expect(await submit(live, D1, 5)).toBe("not_sold");
  });

  it("rejects a rater who is neither buyer nor seller", async () => {
    const id = await makeSold();
    expect(await submit(id, D2, 5)).toBe("not_party");
  });

  it("rejects a second rating from the same party", async () => {
    const id = await makeSold();
    await submit(id, D1, 5);
    expect(await submit(id, D1, 3)).toBe("already_rated");
  });

  it("rejects a rating after the 14-day window has closed", async () => {
    const id = await makeSold();
    await admin.rpc("test_set_settlement_age", { p_auction_id: id, p_seconds: 15 * 86400 });
    expect(await submit(id, D1, 5)).toBe("window_closed");
  });

  it("rejects an out-of-range score", async () => {
    const id = await makeSold();
    expect(await submit(id, D1, 6)).toBe("bad_score");
  });

  it("forbids the anon (browser) role from calling the writer", async () => {
    const id = await makeSold();
    const { error } = await anon.rpc("submit_rating", {
      p_auction_id: id, p_rater_dealer_id: D1, p_score: 5, p_comment: null,
    });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ratings.test.ts`
Expected: FAIL — `createSoldAuction` is not exported / `submit_rating` RPC does not exist.

- [ ] **Step 3: Add the test helper**

In `tests/helpers/db.ts`, add `ratings` cleanup at the top of `deleteAuctions` (before the `bids` delete):

```ts
  await admin.from("ratings").delete().in("auction_id", ids);
```

Then append this helper to the end of the file:

```ts
// Create a live auction owned by `seller`, take one bid above reserve from `buyer`,
// expire it and close it to 'sold'. Returns the (now sold) auction id. Caller cleans
// up via deleteAuctions([...]). createLiveAuction uses reserve = 1_200_000c.
export async function createSoldAuction(seller: string, buyer: string): Promise<string> {
  const id = await createLiveAuction(seller);
  await admin.rpc("place_bid", { p_auction_id: id, p_dealer_id: buyer, p_max_amount: 1300000 });
  await admin.rpc("test_set_end_in_seconds", { p_auction_id: id, p_seconds: -1 });
  await admin.rpc("close_auction", { p_auction_id: id });
  return id;
}
```

- [ ] **Step 4: Create the migration**

Create `supabase/migrations/0012_ratings.sql`:

```sql
-- Slice 12: trade rating / reputation. Bidirectional, blind-reveal ratings left after a sale.
-- The ratings rows are the single source of truth; visibility and averages are derived on read.
-- This migration is built up across the ratings tasks; run `npx supabase db reset` after each edit.

create table ratings (
  id              uuid primary key default gen_random_uuid(),
  auction_id      uuid not null references auctions(id),
  rater_dealer_id uuid not null references dealers(id),
  ratee_dealer_id uuid not null references dealers(id),
  direction       text not null check (direction in ('seller','buyer')),
  score           int  not null check (score between 1 and 5),
  comment         text check (comment is null or char_length(comment) <= 280),
  created_at      timestamptz not null default now(),
  unique (auction_id, rater_dealer_id)
);
create index on ratings (ratee_dealer_id, direction);

-- Anchor for the 14-day window: the settlement is inserted exactly at sale time.
alter table settlements add column created_at timestamptz not null default now();

-- ── Writer: submit one rating. service_role only; identity comes from the server cookie. ──
create or replace function submit_rating(
  p_auction_id uuid, p_rater_dealer_id uuid, p_score int, p_comment text
) returns text language plpgsql security definer set search_path = public as $$
declare
  a auctions%rowtype;
  s settlements%rowtype;
  v_ratee uuid;
  v_direction text;
begin
  if p_score < 1 or p_score > 5 then return 'bad_score'; end if;

  select * into a from auctions where id = p_auction_id;
  if not found or a.status <> 'sold' then return 'not_sold'; end if;
  if a.seller_dealer_id = a.current_winner_dealer_id then return 'not_party'; end if;

  if p_rater_dealer_id = a.seller_dealer_id then
    v_ratee := a.current_winner_dealer_id; v_direction := 'buyer';
  elsif p_rater_dealer_id = a.current_winner_dealer_id then
    v_ratee := a.seller_dealer_id; v_direction := 'seller';
  else
    return 'not_party';
  end if;

  select * into s from settlements where auction_id = p_auction_id;
  if not found then return 'not_sold'; end if;
  if s.created_at + interval '14 days' <= now() then return 'window_closed'; end if;

  if exists (select 1 from ratings where auction_id = p_auction_id and rater_dealer_id = p_rater_dealer_id) then
    return 'already_rated';
  end if;

  insert into ratings (auction_id, rater_dealer_id, ratee_dealer_id, direction, score, comment)
    values (p_auction_id, p_rater_dealer_id, v_ratee, v_direction, p_score,
            nullif(btrim(coalesce(p_comment, '')), ''));
  return 'ok';
end; $$;

revoke execute on function submit_rating(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function submit_rating(uuid, uuid, int, text) to service_role;

-- ratings table: service_role only (blind-safety — reads go through reader functions).
grant select, insert, update, delete on ratings to service_role;

-- ── Test helper: backdate a settlement to exercise the window-elapsed path. ──
create or replace function test_set_settlement_age(p_auction_id uuid, p_seconds int)
returns void language sql security definer set search_path = public as $$
  update settlements set created_at = now() - make_interval(secs => p_seconds)
  where auction_id = p_auction_id;
$$;

-- Extend test_reset (last defined in 0009) to also clear ratings between tests.
create or replace function test_reset() returns void language plpgsql security definer as $$
begin
  truncate ratings restart identity cascade;
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

- [ ] **Step 5: Apply the migration**

Run: `npx supabase db reset`
Expected: reset completes, all migrations + seed applied, no SQL errors.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/ratings.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0012_ratings.sql tests/helpers/db.ts tests/ratings.test.ts
git commit -m "Add ratings table and submit_rating writer (Slice 12)"
```

---

### Task 2: "Rate your deal" notifications on close / buy-now

**Files:**
- Modify: `supabase/migrations/0012_ratings.sql` (append)
- Test: `tests/ratings.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `_notify(uuid, text, uuid)` (from 0009), `createSoldAuction` (Task 1).
- Produces: `close_auction` and `buy_now_listing` also emit a `'rate'` notification to each party; `notifications.type` now allows `'rate'`.

- [ ] **Step 1: Write the failing test**

Append to `tests/ratings.test.ts`:

```ts
describe("rate-your-deal notifications", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("close_auction notifies both parties to rate", async () => {
    const id = await makeSold(); // seller D3, buyer D1, closed inside the helper
    const { data: n } = await admin.from("notifications").select("*").eq("auction_id", id).eq("type", "rate");
    const recips = (n ?? []).map((r) => r.recipient_dealer_id).sort();
    expect(recips).toEqual([D1, D3].sort());
  });

  it("buy_now_listing notifies both parties to rate", async () => {
    const CRV = "a0000000-0000-0000-0000-000000000a03"; // seed buy-now auction, seller D3
    const { error } = await admin.rpc("buy_now_listing", { p_auction_id: CRV, p_buyer_dealer_id: D1 });
    if (error) throw error;
    const { data: n } = await admin.from("notifications").select("*").eq("auction_id", CRV).eq("type", "rate");
    const recips = (n ?? []).map((r) => r.recipient_dealer_id).sort();
    expect(recips).toEqual([D1, D3].sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ratings.test.ts -t "rate-your-deal"`
Expected: FAIL — no `'rate'` notifications exist (and the type-check constraint would reject them).

- [ ] **Step 3: Append the migration changes**

Append to `supabase/migrations/0012_ratings.sql`:

```sql
-- ── 'rate' notification type + emit it at settlement from both writers ──
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('outbid','won','sold','withdrawn','rate'));

-- close_auction: keep the 0009 body; add a 'rate' prompt to winner and seller on a sale.
create or replace function close_auction(p_auction_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
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
    perform _notify(a.current_winner_dealer_id, 'rate', p_auction_id);
    perform _notify(a.seller_dealer_id, 'rate', p_auction_id);
    return 'sold';
  else
    update auctions set status = 'passed' where id = p_auction_id;
    return 'passed';
  end if;
end; $$;

-- buy_now_listing: keep the 0009 body; add a 'rate' prompt to buyer and seller.
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
  perform _notify(p_buyer_dealer_id, 'rate', p_auction_id);
  perform _notify(a.seller_dealer_id, 'rate', p_auction_id);
  return 'bought';
end; $$;
```

- [ ] **Step 4: Apply the migration**

Run: `npx supabase db reset`
Expected: no SQL errors.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ratings.test.ts`
Expected: PASS (10 tests — the 8 from Task 1 plus 2 new).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_ratings.sql tests/ratings.test.ts
git commit -m "Emit rate-your-deal notifications on sale (Slice 12)"
```

---

### Task 3: Blind-safe read path — reader RPCs, `src/lib/ratings.ts`, types

**Files:**
- Modify: `supabase/migrations/0012_ratings.sql` (append)
- Create: `src/lib/ratings.ts`
- Modify: `src/types/db.ts` (add rating types; add `'rate'` to `NotificationType`)
- Test: `tests/ratings.test.ts` (append visibility describe block), `tests/ratings_service.test.ts` (new)

**Interfaces:**
- Produces (SQL RPCs, all `security definer`, granted execute to `anon, authenticated`):
  - `get_dealers_reputation(p_dealer_ids uuid[]) returns table(dealer_id uuid, seller_avg numeric, seller_count int, buyer_avg numeric, buyer_count int)` — one row per requested dealer, aggregated over visible rows.
  - `get_dealer_reviews(p_dealer_id uuid) returns table(direction text, score int, comment text, created_at timestamptz)` — visible rows, newest first.
  - `get_rating_state(p_auction_id uuid, p_viewer_dealer_id uuid) returns table(eligible boolean, window_open boolean, already_rated boolean, counterpart_submitted boolean, revealed boolean, my_score int, my_comment text, counterpart_score int, counterpart_comment text)`.
- Produces (TS): `submitRating`, `getDealersReputation`, `getDealerReviews`, `getRatingState` in `src/lib/ratings.ts`, plus `DealerReputation`, `DealerReview`, `RatingState` types.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ratings.test.ts` (uses the existing `makeSold`, `submit`, `created`, `D1`–`D3`; add `D4`):

```ts
const D4 = "44444444-4444-4444-4444-444444444444"; // never rated

describe("blind-reveal visibility", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  async function repOf(dealer: string) {
    const { data } = await admin.rpc("get_dealers_reputation", { p_dealer_ids: [dealer] });
    return (data as any[])[0];
  }
  async function stateFor(auction: string, viewer: string) {
    const { data } = await admin.rpc("get_rating_state", { p_auction_id: auction, p_viewer_dealer_id: viewer });
    return (data as any[])[0];
  }

  it("hides a lone rating from the counterparty and from the aggregate until reveal", async () => {
    const id = await makeSold();
    await submit(id, D1, 5); // buyer rates seller D3; only one rating so far
    const sellerRep = await repOf(D3);
    expect(sellerRep.seller_count).toBe(0);        // not visible yet
    const stateForSeller = await stateFor(id, D3);
    expect(stateForSeller.counterpart_submitted).toBe(true);
    expect(stateForSeller.revealed).toBe(false);
    expect(stateForSeller.counterpart_score).toBeNull(); // blind
  });

  it("reveals both ratings once both parties have submitted", async () => {
    const id = await makeSold();
    await submit(id, D1, 5);
    await submit(id, D3, 4);
    const sellerRep = await repOf(D3);
    const buyerRep = await repOf(D1);
    expect(sellerRep.seller_count).toBe(1);
    expect(Number(sellerRep.seller_avg)).toBe(5);
    expect(buyerRep.buyer_count).toBe(1);
    expect(Number(buyerRep.buyer_avg)).toBe(4);
    const state = await stateFor(id, D1);
    expect(state.revealed).toBe(true);
    expect(state.counterpart_score).toBe(4);
  });

  it("reveals a lone rating once the 14-day window elapses", async () => {
    const id = await makeSold();
    await submit(id, D1, 3);
    await admin.rpc("test_set_settlement_age", { p_auction_id: id, p_seconds: 15 * 86400 });
    const sellerRep = await repOf(D3);
    expect(sellerRep.seller_count).toBe(1);
    expect(Number(sellerRep.seller_avg)).toBe(3);
  });

  it("returns a zero-filled row for a dealer with no visible ratings", async () => {
    const rep = await repOf(D4);
    expect(rep.dealer_id).toBe(D4);
    expect(rep.seller_count).toBe(0);
    expect(rep.seller_avg).toBeNull();
  });

  it("marks a non-party viewer ineligible", async () => {
    const id = await makeSold();
    const state = await stateFor(id, D4);
    expect(state.eligible).toBe(false);
  });
});
```

Create `tests/ratings_service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, resetDb, createSoldAuction, deleteAuctions } from "./helpers/db";
import { getDealersReputation, getDealerReviews, getRatingState } from "@/lib/ratings";

const D1 = "11111111-1111-1111-1111-111111111111";
const D3 = "33333333-3333-3333-3333-333333333333";

const created: string[] = [];

describe("ratings library (readers)", () => {
  beforeEach(resetDb);
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("getDealersReputation returns a row per requested dealer", async () => {
    const id = await createSoldAuction(D3, D1); created.push(id);
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D1, p_score: 5, p_comment: "Tidy" });
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D3, p_score: 4, p_comment: null });
    const reps = await getDealersReputation(admin, [D3, D1]);
    const seller = reps.find((r) => r.dealer_id === D3)!;
    expect(seller.seller_count).toBe(1);
    expect(Number(seller.seller_avg)).toBe(5);
  });

  it("getDealerReviews returns visible comments for the ratee", async () => {
    const id = await createSoldAuction(D3, D1); created.push(id);
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D1, p_score: 5, p_comment: "Tidy" });
    await admin.rpc("submit_rating", { p_auction_id: id, p_rater_dealer_id: D3, p_score: 4, p_comment: null });
    const reviews = await getDealerReviews(admin, D3);
    expect(reviews[0].direction).toBe("seller");
    expect(reviews[0].comment).toBe("Tidy");
  });

  it("getRatingState reports eligibility for a party", async () => {
    const id = await createSoldAuction(D3, D1); created.push(id);
    const state = await getRatingState(admin, id, D1);
    expect(state?.eligible).toBe(true);
    expect(state?.already_rated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ratings.test.ts tests/ratings_service.test.ts`
Expected: FAIL — reader RPCs and `@/lib/ratings` do not exist.

- [ ] **Step 3: Append the reader functions to the migration**

Append to `supabase/migrations/0012_ratings.sql`:

```sql
-- ── Readers (blind-safe, derive on read). security definer so they can read the
-- ── service-role-only ratings table; granted to anon/authenticated for page use. ──

-- Per-dealer seller/buyer averages over VISIBLE ratings; one row per requested id.
create or replace function get_dealers_reputation(p_dealer_ids uuid[])
returns table (dealer_id uuid, seller_avg numeric, seller_count int, buyer_avg numeric, buyer_count int)
language sql security definer set search_path = public as $$
  with visible as (
    select r.*
    from ratings r
    join settlements s on s.auction_id = r.auction_id
    where (select count(*) from ratings r2 where r2.auction_id = r.auction_id) = 2
       or s.created_at + interval '14 days' <= now()
  )
  select d.id,
    round(avg(v.score) filter (where v.direction = 'seller'), 1),
    count(*) filter (where v.direction = 'seller')::int,
    round(avg(v.score) filter (where v.direction = 'buyer'), 1),
    count(*) filter (where v.direction = 'buyer')::int
  from unnest(p_dealer_ids) as d(id)
  left join visible v on v.ratee_dealer_id = d.id
  group by d.id;
$$;

-- Visible reviews about a dealer, newest first.
create or replace function get_dealer_reviews(p_dealer_id uuid)
returns table (direction text, score int, comment text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select r.direction, r.score, r.comment, r.created_at
  from ratings r
  join settlements s on s.auction_id = r.auction_id
  where r.ratee_dealer_id = p_dealer_id
    and ((select count(*) from ratings r2 where r2.auction_id = r.auction_id) = 2
         or s.created_at + interval '14 days' <= now())
  order by r.created_at desc;
$$;

-- Everything the rate panel needs for one viewer on one auction.
create or replace function get_rating_state(p_auction_id uuid, p_viewer_dealer_id uuid)
returns table (
  eligible boolean, window_open boolean, already_rated boolean,
  counterpart_submitted boolean, revealed boolean,
  my_score int, my_comment text, counterpart_score int, counterpart_comment text
) language plpgsql security definer set search_path = public as $$
declare
  a auctions%rowtype; s settlements%rowtype;
  v_mine ratings%rowtype; v_theirs ratings%rowtype;
  v_count int; v_revealed boolean;
begin
  select * into a from auctions where id = p_auction_id;
  if not found or a.status <> 'sold' or a.seller_dealer_id = a.current_winner_dealer_id
     or p_viewer_dealer_id not in (a.seller_dealer_id, a.current_winner_dealer_id) then
    return query select false, false, false, false, false,
      null::int, null::text, null::int, null::text;
    return;
  end if;

  select * into s from settlements where auction_id = p_auction_id;
  select count(*) into v_count from ratings where auction_id = p_auction_id;
  select * into v_mine from ratings
    where auction_id = p_auction_id and rater_dealer_id = p_viewer_dealer_id;
  select * into v_theirs from ratings
    where auction_id = p_auction_id and rater_dealer_id <> p_viewer_dealer_id limit 1;
  v_revealed := (v_count = 2) or (s.created_at + interval '14 days' <= now());

  return query select
    true,
    (s.created_at + interval '14 days' > now()),
    (v_mine.id is not null),
    (v_theirs.id is not null),
    v_revealed,
    v_mine.score, v_mine.comment,
    case when v_revealed then v_theirs.score else null end,
    case when v_revealed then v_theirs.comment else null end;
end; $$;

grant execute on function get_dealers_reputation(uuid[]) to anon, authenticated, service_role;
grant execute on function get_dealer_reviews(uuid) to anon, authenticated, service_role;
grant execute on function get_rating_state(uuid, uuid) to anon, authenticated, service_role;
```

- [ ] **Step 4: Add the rating types**

In `src/types/db.ts`, change the notification type union to include `'rate'`:

```ts
export type NotificationType = "outbid" | "won" | "sold" | "withdrawn" | "rate";
```

Then append these types to the end of `src/types/db.ts`:

```ts
export interface Rating {
  id: string; auction_id: string; rater_dealer_id: string; ratee_dealer_id: string;
  direction: "seller" | "buyer"; score: number; comment: string | null; created_at: string;
}
export interface DealerReputation {
  dealer_id: string;
  seller_avg: number | null; seller_count: number;
  buyer_avg: number | null; buyer_count: number;
}
export interface DealerReview {
  direction: "seller" | "buyer"; score: number; comment: string | null; created_at: string;
}
export interface RatingState {
  eligible: boolean; window_open: boolean; already_rated: boolean;
  counterpart_submitted: boolean; revealed: boolean;
  my_score: number | null; my_comment: string | null;
  counterpart_score: number | null; counterpart_comment: string | null;
}
```

Note: `NotificationType` already existed with the first three members; the withdraw slice added `'withdrawn'` only in SQL, so widening the union here also lines it up with the DB constraint.

- [ ] **Step 5: Create the service module**

Create `src/lib/ratings.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import type { DealerReputation, DealerReview, RatingState } from "@/types/db";

// Writer: submit one rating. service_role only; dealer identity comes from the cookie in the action.
export async function submitRating(
  dealerId: string, auctionId: string, score: number, comment: string | null
): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("submit_rating", {
    p_auction_id: auctionId, p_rater_dealer_id: dealerId, p_score: score, p_comment: comment,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "ok" ? { ok: true } : { ok: false, reason: data as string };
}

// Seller/buyer reputation for a set of dealers, one row each. Read via the caller's client.
export async function getDealersReputation(
  sb: SupabaseClient, dealerIds: string[]
): Promise<DealerReputation[]> {
  if (!dealerIds.length) return [];
  const { data } = await sb.rpc("get_dealers_reputation", { p_dealer_ids: dealerIds });
  return (data ?? []) as DealerReputation[];
}

// Visible reviews about a dealer, newest first.
export async function getDealerReviews(sb: SupabaseClient, dealerId: string): Promise<DealerReview[]> {
  const { data } = await sb.rpc("get_dealer_reviews", { p_dealer_id: dealerId });
  return (data ?? []) as DealerReview[];
}

// Rate-panel state for one viewer on one auction (returns a single row, or null if unknown).
export async function getRatingState(
  sb: SupabaseClient, auctionId: string, viewerId: string
): Promise<RatingState | null> {
  const { data } = await sb.rpc("get_rating_state", {
    p_auction_id: auctionId, p_viewer_dealer_id: viewerId,
  });
  const row = Array.isArray(data) ? data[0] : data;
  return (row as RatingState) ?? null;
}
```

- [ ] **Step 6: Apply the migration and run the tests**

Run: `npx supabase db reset`
Then: `npx vitest run tests/ratings.test.ts tests/ratings_service.test.ts`
Expected: PASS (all ratings RPC tests plus the 3 service tests).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0012_ratings.sql src/lib/ratings.ts src/types/db.ts tests/ratings.test.ts tests/ratings_service.test.ts
git commit -m "Add blind-safe reputation read path and ratings service (Slice 12)"
```

---

### Task 4: Dealer profile reputation + reviews, and drop the static rating

**Files:**
- Modify: `supabase/migrations/0012_ratings.sql` (append the column drop)
- Modify: `supabase/seed.sql` (remove `rating` from the dealers insert)
- Modify: `src/types/db.ts` (remove `rating` from `Dealer`)
- Create: `src/components/Stars.tsx`
- Modify: `src/app/dealer/[id]/page.tsx`

**Interfaces:**
- Consumes: `getDealersReputation`, `getDealerReviews` (Task 3), `serverClient` (existing).
- Produces: `Stars` display component — `Stars({ score }: { score: number })`.

- [ ] **Step 1: Append the column drop to the migration**

Append to `supabase/migrations/0012_ratings.sql`:

```sql
-- The static per-dealer rating is replaced by derived reputation; remove it.
alter table dealers drop column rating;
```

- [ ] **Step 2: Remove `rating` from the seed**

In `supabase/seed.sql`, change the dealers insert so it no longer sets `rating`. Replace the insert column list and each value row:

```sql
insert into dealers (id, business_name, dealer_license_no, region, initials) values
  ('11111111-1111-1111-1111-111111111111','Auckland Motor Wholesale','MVT12345','Auckland','AM'),
  ('22222222-2222-2222-2222-222222222222','Waikato Trade Cars','MVT23456','Hamilton','WT'),
  ('33333333-3333-3333-3333-333333333333','Capital Auto Traders','MVT34567','Wellington','CA'),
  ('44444444-4444-4444-4444-444444444444','Southern Vehicle Exchange','MVT45678','Christchurch','SV'),
  ('55555555-5555-5555-5555-555555555555','BayCity Dealer Group','MVT56789','Tauranga','BC');
```

- [ ] **Step 3: Remove `rating` from the `Dealer` type**

In `src/types/db.ts`, edit the `Dealer` interface to drop `rating`:

```ts
export interface Dealer {
  id: string; business_name: string; dealer_license_no: string;
  region: string; is_verified: boolean; initials: string;
}
```

- [ ] **Step 4: Create the Stars display component**

Create `src/components/Stars.tsx`:

```tsx
// Read-only star row for a 1-5 score. Rounds to the nearest whole star.
export function Stars({ score }: { score: number }) {
  const filled = Math.round(score);
  return (
    <span aria-label={`${score} out of 5`} className="font-mono text-signal">
      {"★".repeat(filled)}
      <span className="text-line">{"★".repeat(5 - filled)}</span>
    </span>
  );
}
```

- [ ] **Step 5: Rewrite the profile trust header + reviews**

In `src/app/dealer/[id]/page.tsx`, add imports near the top:

```tsx
import { Stars } from "@/components/Stars";
import { getDealersReputation, getDealerReviews } from "@/lib/ratings";
import type { DealerReview } from "@/types/db";
```

Extend the parallel fetch (the existing `Promise.all` with `listings, sales, watchedIds`) to also load reputation and reviews:

```tsx
  const [listings, sales, watchedIds, reps, reviews] = await Promise.all([
    getDealerLiveListings(sb, id),
    getDealerSales(sb, id),
    getWatchedAuctionIds(sb, viewerId),
    getDealersReputation(sb, [id]),
    getDealerReviews(sb, id),
  ]);
  const rep = reps[0];
```

Replace the rating line inside the trust header — the block:

```tsx
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-fog">
              <span className="text-signal">★ {Number(dealer.rating).toFixed(1)}</span>
              <span>{dealer.region}</span>
              <span>Licence {dealer.dealer_license_no}</span>
            </div>
```

with derived seller/buyer reputation:

```tsx
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-fog">
              {rep && rep.seller_count > 0
                ? <span className="text-signal">As seller ★ {Number(rep.seller_avg).toFixed(1)} ({rep.seller_count})</span>
                : <span>As seller — no ratings yet</span>}
              {rep && rep.buyer_count > 0
                ? <span className="text-signal">As buyer ★ {Number(rep.buyer_avg).toFixed(1)} ({rep.buyer_count})</span>
                : <span>As buyer — no ratings yet</span>}
              <span>{dealer.region}</span>
              <span>Licence {dealer.dealer_license_no}</span>
            </div>
```

Then add a reviews section immediately after the closing `</section>` of the trust header (before the "Live listings" section):

```tsx
        {/* Reviews */}
        {reviews.length > 0 && (
          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold text-chalk">Reviews</h2>
            <div className="space-y-2">
              {reviews.map((r: DealerReview, i: number) => (
                <div key={i} className="rounded-lg border border-line bg-panel px-4 py-3">
                  <div className="flex items-center justify-between">
                    <Stars score={r.score} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fog">
                      {r.direction === "seller" ? "As seller" : "As buyer"}
                    </span>
                  </div>
                  {r.comment && <p className="mt-1.5 text-sm text-chalk">{r.comment}</p>}
                </div>
              ))}
            </div>
          </section>
        )}
```

- [ ] **Step 6: Apply the migration and check the build**

Run: `npx supabase db reset`
Then: `npx tsc --noEmit`
Expected: reset succeeds; TypeScript reports no errors (no dangling `dealer.rating` references).

- [ ] **Step 7: Run the full unit suite to confirm nothing regressed**

Run: `npm run test`
Expected: PASS (existing suites plus the ratings suites).

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0012_ratings.sql supabase/seed.sql src/types/db.ts src/components/Stars.tsx "src/app/dealer/[id]/page.tsx"
git commit -m "Show derived seller/buyer reputation on dealer profile (Slice 12)"
```

---

### Task 5: Rate panel on the auction page

**Files:**
- Create: `src/app/auction/actions.ts` (non-dynamic folder, so client imports avoid literal `[id]` brackets in the specifier)
- Create: `src/components/RateDealPanel.tsx`
- Modify: `src/app/auction/[id]/page.tsx`

**Interfaces:**
- Consumes: `submitRating`, `getRatingState` (Task 3), `Stars` (Task 4), `getDealerId` (existing).
- Produces: `submitRatingAction(prev, formData)` server action; `RateDealPanel` client component with prop `{ auctionId: string; state: RatingState }`.

- [ ] **Step 1: Create the server action**

Create `src/app/auction/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { submitRating } from "@/lib/ratings";

const MESSAGES: Record<string, string> = {
  not_sold: "This auction isn't a completed sale.",
  not_party: "Only the buyer and seller can rate this deal.",
  window_closed: "The rating window has closed.",
  already_rated: "You've already rated this deal.",
  bad_score: "Choose a score from 1 to 5.",
  error: "Could not submit rating, try again.",
};

export async function submitRatingAction(
  _prev: { error?: string }, formData: FormData
): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const score = Number(formData.get("score") || 0);
  const comment = String(formData.get("comment") || "").trim() || null;
  const r = await submitRating(dealerId, auctionId, score, comment);
  if (r.ok) {
    revalidatePath(`/auction/${auctionId}`);
    return {};
  }
  return { error: MESSAGES[r.reason ?? "error"] ?? "Could not submit rating." };
}
```

- [ ] **Step 2: Create the RateDealPanel client component**

Create `src/components/RateDealPanel.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import type { RatingState } from "@/types/db";
import { submitRatingAction } from "@/app/auction/actions";
import { Stars } from "@/components/Stars";

export function RateDealPanel({ auctionId, state }: { auctionId: string; state: RatingState }) {
  const [result, action, pending] = useActionState(submitRatingAction, {});
  const [score, setScore] = useState(0);

  if (!state.eligible) return null;

  const wrap = "rounded-xl border border-line bg-panel p-4 space-y-3";
  const heading = (
    <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">Rate this deal</h3>
  );

  // Already revealed: show both sides.
  if (state.revealed) {
    return (
      <div className={wrap}>
        {heading}
        {state.my_score != null && (
          <p className="flex items-center justify-between text-sm text-chalk">
            <span>You rated</span><Stars score={state.my_score} />
          </p>
        )}
        {state.counterpart_score != null ? (
          <div className="border-t border-line pt-3">
            <p className="flex items-center justify-between text-sm text-chalk">
              <span>They rated</span><Stars score={state.counterpart_score} />
            </p>
            {state.counterpart_comment && <p className="mt-1.5 text-sm text-fog">{state.counterpart_comment}</p>}
          </div>
        ) : (
          <p className="text-sm text-fog">The other dealer did not leave a rating.</p>
        )}
      </div>
    );
  }

  // Submitted but still blind.
  if (state.already_rated) {
    return (
      <div className={wrap}>
        {heading}
        <p className="text-sm text-fog">
          Rating submitted. It stays hidden until the other dealer rates or the 14-day window closes.
        </p>
      </div>
    );
  }

  // Window closed without a rating from this dealer.
  if (!state.window_open) {
    return (
      <div className={wrap}>
        {heading}
        <p className="text-sm text-fog">The rating window has closed.</p>
      </div>
    );
  }

  // Open form.
  return (
    <form action={action} className={wrap}>
      {heading}
      <input type="hidden" name="auctionId" value={auctionId} />
      <input type="hidden" name="score" value={score} />
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Rate ${n} ${n === 1 ? "star" : "stars"}`}
            onClick={() => setScore(n)}
            className={`text-2xl transition-colors ${n <= score ? "text-signal" : "text-line hover:text-fog"}`}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        name="comment"
        maxLength={280}
        placeholder="Optional note (how did the deal go?)"
        className="w-full rounded-lg border border-line bg-panel-2 p-2 text-sm text-chalk placeholder:text-fog focus:border-signal/40 focus:outline-none"
        rows={3}
      />
      <button
        type="submit"
        disabled={pending || score === 0}
        className="w-full rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {pending ? "Submitting…" : "Submit rating"}
      </button>
      {result.error && <p className="text-xs text-stop">{result.error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: Wire the panel into the auction page**

In `src/app/auction/[id]/page.tsx`, add imports:

```tsx
import { RateDealPanel } from "@/components/RateDealPanel";
import { getRatingState } from "@/lib/ratings";
```

After the `const { vehicle, seller } = auction;` line, fetch the rating state for sold auctions:

```tsx
  // Rating is offered only on a completed sale, to the buyer or the seller.
  const sbRating = await serverClient();
  const ratingState =
    auction.status === "sold" ? await getRatingState(sbRating, id, currentDealerId) : null;
```

Then in the right-hand column, render the panel above the existing `{rightPanel}` (inside the `<div className="lg:col-span-1 space-y-4">`):

```tsx
          {ratingState?.eligible && (
            <RateDealPanel auctionId={auction.id} state={ratingState} />
          )}
```

- [ ] **Step 4: Check the build**

Run: `npx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 5: Confirm the unit suite still passes**

Run: `npm run test`
Expected: PASS (no regressions; this task is exercised end-to-end in Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/app/auction/actions.ts src/components/RateDealPanel.tsx "src/app/auction/[id]/page.tsx"
git commit -m "Add rate-this-deal panel to the auction page (Slice 12)"
```

---

### Task 6: Seller score on cards, seed demo data, and end-to-end test

**Files:**
- Modify: `src/components/DealerBadge.tsx`
- Modify: `src/components/AuctionCard.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/dealer/[id]/page.tsx`
- Modify: `supabase/seed.sql`
- Test: `tests/e2e/rating.spec.ts`

**Interfaces:**
- Consumes: `getDealersReputation` (Task 3), `Stars` (Task 4), `searchLiveAuctions` / `getWatchedAuctionIds` (existing).
- Produces: `DealerBadge` gains an optional `reputation?: DealerReputation | null` prop; `AuctionCard` gains an optional `sellerReputation?: DealerReputation | null` prop.

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/rating.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";

// Uses a DEDICATED already-sold seed auction (b01, seller = Waikato Trade Cars / D2,
// winner = Auckland Motor Wholesale / D1) that no other spec touches. Sold auctions do
// not appear in the live grid, so this cannot affect discovery/other counts.
const B01 = "/auction/b0000000-0000-0000-0000-000000000b01";
const D2_PROFILE = "/dealer/22222222-2222-2222-2222-222222222222";

async function loginAs(page: Page, dealerName: RegExp) {
  await page.goto("/login");
  await page.getByRole("button", { name: dealerName }).click();
  await expect(page).toHaveURL("/");
}

test("both parties rate a sold deal and the reputation reveals on the profile", async ({ page }) => {
  // Buyer (Auckland / D1) rates the seller.
  await loginAs(page, /Auckland Motor Wholesale/);
  await page.goto(B01);
  await page.getByRole("button", { name: "Rate 5 stars" }).click();
  await page.getByPlaceholder("Optional note (how did the deal go?)").fill("Exactly as graded, quick settlement");
  await page.getByRole("button", { name: "Submit rating" }).click();
  await expect(page.getByText(/stays hidden until the other dealer/i)).toBeVisible();

  // Seller (Waikato / D2) rates the buyer — second rating reveals both.
  await loginAs(page, /Waikato Trade Cars/);
  await page.goto(B01);
  await page.getByRole("button", { name: "Rate 4 stars" }).click();
  await page.getByRole("button", { name: "Submit rating" }).click();
  await expect(page.getByText("They rated")).toBeVisible();

  // The seller's profile now shows an "As seller" score and the buyer's review.
  await page.goto(D2_PROFILE);
  await expect(page.getByText(/As seller ★ 5\.0 \(1\)/)).toBeVisible();
  await expect(page.getByText("Exactly as graded, quick settlement")).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e to verify it fails**

Run: `npm run test:e2e -- rating`
Expected: FAIL — the `b01` auction does not exist yet (404), so the rate panel never appears.

- [ ] **Step 3: Add the dedicated sold auction and demo ratings to the seed**

Append to `supabase/seed.sql`:

```sql
-- ── Slice 12 rating fixtures (SOLD, so they never appear in the live grid) ───────
-- b01: dedicated e2e deal — sold to D1 by D2, settlement fresh, NOT yet rated.
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('bbbbbbb1-0000-0000-0000-000000000001','Toyota','Aqua',2019,'S',61000,'B','White',
    'Recent WOF. Hybrid battery healthy.','Clean city runabout.',
    array['https://media.example-r2.dev/aqua-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, start_time, end_time, status,
  starting_price, reserve_price, buy_now_price, current_bid, current_winner_dealer_id)
select 'b0000000-0000-0000-0000-000000000b01', v.id,
  '22222222-2222-2222-2222-222222222222', now() - interval '1 hour', now(), 'sold',
  600000, 700000, 900000, 780000, '11111111-1111-1111-1111-111111111111'
from v;
insert into settlements (auction_id, sale_price) values
  ('b0000000-0000-0000-0000-000000000b01', 780000);

-- b02: demo deal — sold and already rated by BOTH sides, so profiles are not empty.
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('bbbbbbb2-0000-0000-0000-000000000002','Mazda','Axela',2018,'SP25',72000,'B','Grey',
    'Tidy. New front tyres.','Well kept trade-in.',
    array['https://media.example-r2.dev/axela-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, start_time, end_time, status,
  starting_price, reserve_price, buy_now_price, current_bid, current_winner_dealer_id)
select 'b0000000-0000-0000-0000-000000000b02', v.id,
  '55555555-5555-5555-5555-555555555555', now() - interval '2 hours', now() - interval '1 hour', 'sold',
  700000, 800000, 1000000, 880000, '33333333-3333-3333-3333-333333333333'
from v;
insert into settlements (auction_id, sale_price) values
  ('b0000000-0000-0000-0000-000000000b02', 880000);
-- Both parties rated → both rows visible (count = 2). Buyer D3 rates seller D5; seller D5 rates buyer D3.
insert into ratings (auction_id, rater_dealer_id, ratee_dealer_id, direction, score, comment) values
  ('b0000000-0000-0000-0000-000000000b02','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','seller',5,'Car matched the listing exactly.'),
  ('b0000000-0000-0000-0000-000000000b02','55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','buyer',5,'Paid promptly, easy pickup.');
```

Note: `test_reset` (unit tests) reverts non-draft auctions to live and truncates settlements/ratings, so these demo rows are pristine only right after `db reset`. That matches how every seed auction is already treated (e2e resets first via global setup).

- [ ] **Step 4: Add the reputation prop to DealerBadge**

Replace `src/components/DealerBadge.tsx` entirely:

```tsx
import { Dealer, DealerReputation } from "@/types/db";

export function DealerBadge({
  dealer,
  reputation,
}: {
  dealer: Dealer;
  reputation?: DealerReputation | null;
}) {
  const hasScore = reputation && reputation.seller_count > 0;
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fog">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-ink font-mono text-[10px] font-bold uppercase text-signal">
        {dealer.initials}
      </span>
      <span className="max-w-[140px] truncate text-chalk">{dealer.business_name}</span>
      {dealer.is_verified && (
        <span className="text-go" title="Verified">✓</span>
      )}
      {hasScore ? (
        <span className="font-mono text-signal">★ {Number(reputation!.seller_avg).toFixed(1)}</span>
      ) : (
        <span className="font-mono text-fog">New</span>
      )}
    </span>
  );
}
```

- [ ] **Step 5: Thread the seller reputation through AuctionCard**

In `src/components/AuctionCard.tsx`, add the import:

```tsx
import { Auction, Vehicle, Dealer, DealerReputation } from "@/types/db";
```

Change the component signature to accept `sellerReputation` and pass it to the badge. Replace the props destructure and the `<DealerBadge dealer={seller} />` usage:

```tsx
export function AuctionCard({
  auction,
  watched = false,
  sellerReputation = null,
}: {
  auction: AuctionWithJoins;
  watched?: boolean;
  sellerReputation?: DealerReputation | null;
}) {
```

```tsx
          <DealerBadge dealer={seller} reputation={sellerReputation} />
```

- [ ] **Step 6: Fetch and pass reputation on the home grid**

In `src/app/page.tsx`, add the import:

```tsx
import { getDealersReputation } from "@/lib/ratings";
```

After the existing `const watched = new Set(watchedIds);` line, build a reputation map over the distinct sellers on the page:

```tsx
  const sellerIds = [...new Set(auctions.map((a) => (a as { seller_dealer_id: string }).seller_dealer_id))];
  const reps = await getDealersReputation(sb, sellerIds);
  const repBySeller = new Map(reps.map((r) => [r.dealer_id, r]));
```

Then pass it into each card — replace the existing `<AuctionCard ... />` in the map:

```tsx
            <AuctionCard
              key={a.id}
              auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
              watched={watched.has(a.id)}
              sellerReputation={repBySeller.get((a as { seller_dealer_id: string }).seller_dealer_id) ?? null}
            />
```

- [ ] **Step 7: Pass reputation on the profile listings grid**

In `src/app/dealer/[id]/page.tsx`, the listings all share one seller (the profile dealer), whose reputation is already loaded as `rep` (Task 4). Pass it into each card — replace the `<AuctionCard ... />` inside the "Live listings" map:

```tsx
                <AuctionCard
                  key={a.id}
                  auction={a as Parameters<typeof AuctionCard>[0]["auction"]}
                  watched={watched.has(a.id)}
                  sellerReputation={rep ?? null}
                />
```

- [ ] **Step 8: Run the build, unit suite, and e2e**

Run: `npx tsc --noEmit`
Then: `npm run test`
Then: `npm run test:e2e -- rating`
Expected: no type errors; unit suites pass; the rating e2e passes (global setup reseeds `b01`/`b02` via `db reset`).

- [ ] **Step 9: Commit**

```bash
git add src/components/DealerBadge.tsx src/components/AuctionCard.tsx src/app/page.tsx "src/app/dealer/[id]/page.tsx" supabase/seed.sql tests/e2e/rating.spec.ts
git commit -m "Show seller score on auction cards, seed demo ratings, add e2e (Slice 12)"
```

---

## Post-implementation verification

After Task 6, run the whole suite once more to confirm the slice is green end to end:

```bash
npm run test            # all Vitest unit + RPC suites
npm run test:e2e        # all Playwright specs (global setup resets the DB first)
npx tsc --noEmit        # type check
npm run lint            # eslint
```

Expected: all green. Then update `code/wiki/franklin.md` (Slice 12 shipped: real bidirectional blind-reveal reputation replacing the static rating) and correct the R2-vs-S3 note flagged earlier.
