# Slice 2 — Listing Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in dealer create a vehicle auction as a draft, preview it, and publish it live.

**Architecture:** Writes go through three `SECURITY DEFINER` Postgres functions granted to `service_role` only; Next.js server actions (seller identity from the httpOnly `dealer_id` cookie) call them via a server-only service-role client. Photos upload directly to Cloudflare R2 via presigned PUT URLs minted by a server route. The anon browser client stays read-only exactly as in Slice 1.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Tailwind v4, Supabase (Postgres) local, Vitest, Playwright, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` for R2.

## Global Constraints

- Bids are created **only** through `place_bid`; the new listing RPCs never touch `bids`.
- The new RPCs are `SECURITY DEFINER`, `set search_path = public`, and granted EXECUTE to **`service_role` only — never `anon`**. The anon client stays read-only (SELECT + EXECUTE on `place_bid`/`close_auction` only).
- The service-role key is server-only — never `NEXT_PUBLIC`, never imported into a `"use client"` module.
- Seller identity always comes from the httpOnly `dealer_id` cookie server-side; never trusted from client input.
- All money is integer **cents** (NZD) in the DB and in `ListingInput`; the form converts dollars→cents before validating. Format with `formatNZD` for display only.
- Auction statuses are exactly: `draft`, `live`, `ended`, `sold`, `passed`. Vehicle grades: `A`, `B`, `C`, `D`, `E`.
- Defaults `bid_increment=25000`, `anti_snipe_seconds=30` keep their DB defaults; not set by the form.
- Validation thresholds: year 1980…(current year + 1); odometer ≥ 0; starting_price > 0; reserve ≥ starting; buy-now (if set) > reserve; end_time in the future and ≤ 30 days out; 1–12 photos; per-file ≤ 10 MB; content-type `image/*`.
- Commit messages are a single line, no co-author trailer. Work on branch `feat/slice2-listing-creation`; never push to `main`.

---

## File Structure

```
supabase/migrations/0004_listings.sql      # enum 'draft', start_time nullable, 3 RPCs, grants
src/types/db.ts                            # (modify) AuctionStatus += 'draft'; start_time nullable
src/lib/listings/validation.ts             # pure ListingInput validation
src/lib/listings/service.ts                # createDraft/updateDraft/publish (service-role + validation)
src/lib/supabase/service.ts                # server-only service-role client
src/lib/r2.ts                              # R2 presign + public-url helpers
src/lib/auctions.ts                        # (modify) add getAuctionById (includes draft)
src/app/api/uploads/presign/route.ts       # POST presign endpoint
src/app/sell/page.tsx                      # create form page
src/app/sell/[id]/page.tsx                 # edit-draft form page
src/app/sell/actions.ts                    # "use server" create/update/publish actions
src/app/auction/[id]/page.tsx              # (modify) owner preview mode for drafts
src/components/ListingForm.tsx             # client form (vehicle + terms + end datetime + uploader)
src/components/PhotoUploader.tsx           # client uploader (presign + PUT to R2)
src/components/PublishPanel.tsx            # client preview-mode publish panel
src/components/Header.tsx                  # "Sell a vehicle" nav link
.env.local.example                         # (modify) R2_* vars
tests/helpers/db.ts                        # (modify) add cleanupDrafts()
tests/listings_rpc.test.ts                 # integration: the 3 RPCs
tests/listings/validation.test.ts          # unit: validateListing
tests/listings/service.test.ts             # integration: service layer
tests/listings/presign.test.ts             # unit: presign route (R2 mocked)
tests/e2e/listing.spec.ts                  # e2e: create→draft→preview→publish
```

---

### Task 1: Listings migration + RPCs (TDD)

**Files:**
- Create: `supabase/migrations/0004_listings.sql`
- Modify: `src/types/db.ts`, `tests/helpers/db.ts`
- Test: `tests/listings_rpc.test.ts`

**Interfaces:**
- Produces RPCs:
  - `create_draft_listing(p_dealer_id uuid, p_make text, p_model text, p_year int, p_variant text, p_odometer_km int, p_grade vehicle_grade, p_color text, p_mechanical_notes text, p_appraisal_notes text, p_photo_urls text[], p_starting_price int, p_reserve_price int, p_buy_now_price int, p_end_time timestamptz) RETURNS uuid` (the new auction id)
  - `update_draft_listing(p_auction_id uuid, p_dealer_id uuid, <same vehicle+terms params as above>) RETURNS text` (`'updated'` | `'not_owner'` | `'not_draft'`)
  - `publish_listing(p_auction_id uuid, p_dealer_id uuid) RETURNS text` (`'live'` | `'not_owner'` | `'not_draft'` | `'end_in_past'` | `'no_photos'`)
- Produces test helper `cleanupDrafts()`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/listings_rpc.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { admin, cleanupDrafts } from "./helpers/db";

const SELLER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function draftArgs(overrides: Record<string, unknown> = {}) {
  return {
    p_dealer_id: SELLER,
    p_make: "Toyota", p_model: "Hilux", p_year: 2021, p_variant: "SR5",
    p_odometer_km: 40000, p_grade: "A", p_color: "White",
    p_mechanical_notes: "Tidy", p_appraisal_notes: "Clean",
    p_photo_urls: ["https://img.example/h1.jpg"],
    p_starting_price: 1000000, p_reserve_price: 1200000, p_buy_now_price: 1500000,
    p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
    ...overrides,
  };
}

describe("listing RPCs", () => {
  beforeEach(cleanupDrafts);

  it("creates a draft auction owned by the dealer, hidden from live", async () => {
    const { data: id, error } = await admin.rpc("create_draft_listing", draftArgs());
    expect(error).toBeNull();
    const { data: a } = await admin.from("auctions").select("*").eq("id", id).single();
    expect(a.status).toBe("draft");
    expect(a.seller_dealer_id).toBe(SELLER);
    expect(a.start_time).toBeNull();
    const { data: live } = await admin.from("auctions").select("id").eq("status", "live").eq("id", id);
    expect(live).toHaveLength(0);
  });

  it("rejects update from a non-owner", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs());
    const { data: r } = await admin.rpc("update_draft_listing", {
      p_auction_id: id, p_dealer_id: OTHER, p_make: "Toyota", p_model: "Hilux",
      p_year: 2021, p_variant: "SR5", p_odometer_km: 41000, p_grade: "A",
      p_color: "White", p_mechanical_notes: "x", p_appraisal_notes: "y",
      p_photo_urls: ["https://img.example/h1.jpg"], p_starting_price: 1000000,
      p_reserve_price: 1200000, p_buy_now_price: 1500000,
      p_end_time: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    expect(r).toBe("not_owner");
  });

  it("publishes a valid draft to live with a start_time", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs());
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: SELLER });
    expect(r).toBe("live");
    const { data: a } = await admin.from("auctions").select("status, start_time").eq("id", id).single();
    expect(a.status).toBe("live");
    expect(a.start_time).not.toBeNull();
  });

  it("refuses to publish with an end_time in the past", async () => {
    const { data: id } = await admin.rpc("create_draft_listing",
      draftArgs({ p_end_time: new Date(Date.now() - 3600000).toISOString() }));
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: SELLER });
    expect(r).toBe("end_in_past");
  });

  it("refuses to publish with no photos", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs({ p_photo_urls: [] }));
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: SELLER });
    expect(r).toBe("no_photos");
  });

  it("refuses to publish someone else's draft", async () => {
    const { data: id } = await admin.rpc("create_draft_listing", draftArgs());
    const { data: r } = await admin.rpc("publish_listing", { p_auction_id: id, p_dealer_id: OTHER });
    expect(r).toBe("not_owner");
  });
});
```

- [ ] **Step 2: Add the `cleanupDrafts` helper**

Append to `tests/helpers/db.ts`:

```ts
// Remove draft auctions (and their now-orphaned vehicles) created by listing tests.
export async function cleanupDrafts() {
  const { data: drafts } = await admin.from("auctions").select("id, vehicle_id").eq("status", "draft");
  const ids = (drafts ?? []).map((d) => d.id);
  const vids = (drafts ?? []).map((d) => d.vehicle_id);
  if (ids.length) await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/listings_rpc.test.ts`
Expected: FAIL — `create_draft_listing` does not exist (function not found).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0004_listings.sql`:

```sql
-- Slice 2: listing creation. Draft status + nullable start_time + writer RPCs.
alter type auction_status add value if not exists 'draft';
alter table auctions alter column start_time drop not null;

-- Create a draft listing (vehicle + draft auction) atomically. Returns auction id.
create or replace function create_draft_listing(
  p_dealer_id uuid, p_make text, p_model text, p_year int, p_variant text,
  p_odometer_km int, p_grade vehicle_grade, p_color text,
  p_mechanical_notes text, p_appraisal_notes text, p_photo_urls text[],
  p_starting_price int, p_reserve_price int, p_buy_now_price int, p_end_time timestamptz
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_vehicle uuid; v_auction uuid;
begin
  insert into vehicles (make, model, year, variant, odometer_km, grade, color,
    mechanical_notes, appraisal_notes, photo_urls)
  values (p_make, p_model, p_year, p_variant, p_odometer_km, p_grade, p_color,
    p_mechanical_notes, p_appraisal_notes, coalesce(p_photo_urls, '{}'))
  returning id into v_vehicle;

  insert into auctions (vehicle_id, seller_dealer_id, start_time, end_time, status,
    starting_price, reserve_price, buy_now_price)
  values (v_vehicle, p_dealer_id, null, p_end_time, 'draft',
    p_starting_price, p_reserve_price, p_buy_now_price)
  returning id into v_auction;

  return v_auction;
end; $$;

-- Update a draft (vehicle + auction) only if owned by the dealer and still a draft.
create or replace function update_draft_listing(
  p_auction_id uuid, p_dealer_id uuid, p_make text, p_model text, p_year int, p_variant text,
  p_odometer_km int, p_grade vehicle_grade, p_color text,
  p_mechanical_notes text, p_appraisal_notes text, p_photo_urls text[],
  p_starting_price int, p_reserve_price int, p_buy_now_price int, p_end_time timestamptz
) returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'draft' then return 'not_draft'; end if;

  update vehicles set make = p_make, model = p_model, year = p_year, variant = p_variant,
    odometer_km = p_odometer_km, grade = p_grade, color = p_color,
    mechanical_notes = p_mechanical_notes, appraisal_notes = p_appraisal_notes,
    photo_urls = coalesce(p_photo_urls, '{}')
  where id = a.vehicle_id;

  update auctions set starting_price = p_starting_price, reserve_price = p_reserve_price,
    buy_now_price = p_buy_now_price, end_time = p_end_time
  where id = p_auction_id;

  return 'updated';
end; $$;

-- Publish a draft: guard ownership/status, re-validate, flip live with start_time=now().
create or replace function publish_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype; v_photos int;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'draft' then return 'not_draft'; end if;
  if a.end_time <= now() then return 'end_in_past'; end if;
  select coalesce(array_length(photo_urls, 1), 0) into v_photos from vehicles where id = a.vehicle_id;
  if v_photos < 1 then return 'no_photos'; end if;

  update auctions set status = 'live', start_time = now() where id = p_auction_id;
  return 'live';
end; $$;

-- Writers are service-role only: the browser anon key must never reach these.
grant execute on function create_draft_listing(uuid, text, text, int, text, int, vehicle_grade, text, text, text, text[], int, int, int, timestamptz) to service_role;
grant execute on function update_draft_listing(uuid, uuid, text, text, int, text, int, vehicle_grade, text, text, text, text[], int, int, int, timestamptz) to service_role;
grant execute on function publish_listing(uuid, uuid) to service_role;
```

- [ ] **Step 5: Update the row types**

In `src/types/db.ts`, change the status union and `start_time`:

```ts
export type AuctionStatus = "draft" | "live" | "ended" | "sold" | "passed";
```

In the `Auction` interface, change `start_time: string;` to `start_time: string | null;`.

- [ ] **Step 6: Apply the migration and run the test**

Run: `npx supabase db reset && npx vitest run tests/listings_rpc.test.ts`
Expected: PASS (6/6), output pristine.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0004_listings.sql src/types/db.ts tests/helpers/db.ts tests/listings_rpc.test.ts
git commit -m "Add listing draft/update/publish RPCs and draft status"
```

---

### Task 2: Listing validation module (TDD)

**Files:**
- Create: `src/lib/listings/validation.ts`
- Test: `tests/listings/validation.test.ts`

**Interfaces:**
- Produces:
  - `interface ListingInput { make: string; model: string; year: number; variant: string; odometerKm: number; grade: "A"|"B"|"C"|"D"|"E"; color: string; mechanicalNotes: string; appraisalNotes: string; photoUrls: string[]; startingPrice: number; reservePrice: number; buyNowPrice: number | null; endTime: string; }` (prices in **cents**, `endTime` ISO string)
  - `type ValidationErrors = Partial<Record<keyof ListingInput, string>>`
  - `function validateListing(input: ListingInput, nowMs?: number): ValidationErrors` (empty object = valid)

- [ ] **Step 1: Write the failing test**

Create `tests/listings/validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateListing, ListingInput } from "../../src/lib/listings/validation";

const NOW = Date.parse("2026-06-25T00:00:00Z");
function valid(o: Partial<ListingInput> = {}): ListingInput {
  return {
    make: "Toyota", model: "Hilux", year: 2021, variant: "SR5", odometerKm: 40000,
    grade: "A", color: "White", mechanicalNotes: "", appraisalNotes: "",
    photoUrls: ["https://img/1.jpg"], startingPrice: 1000000, reservePrice: 1200000,
    buyNowPrice: 1500000, endTime: new Date(NOW + 2 * 86400000).toISOString(), ...o,
  };
}

describe("validateListing", () => {
  it("accepts a well-formed listing", () => {
    expect(validateListing(valid(), NOW)).toEqual({});
  });
  it("requires make and model", () => {
    expect(validateListing(valid({ make: "  " }), NOW).make).toBeDefined();
    expect(validateListing(valid({ model: "" }), NOW).model).toBeDefined();
  });
  it("bounds the year", () => {
    expect(validateListing(valid({ year: 1979 }), NOW).year).toBeDefined();
    expect(validateListing(valid({ year: 2028 }), NOW).year).toBeDefined();
  });
  it("requires reserve >= starting and buy-now > reserve", () => {
    expect(validateListing(valid({ startingPrice: 1000000, reservePrice: 900000 }), NOW).reservePrice).toBeDefined();
    expect(validateListing(valid({ reservePrice: 1200000, buyNowPrice: 1200000 }), NOW).buyNowPrice).toBeDefined();
  });
  it("requires a future end_time within 30 days", () => {
    expect(validateListing(valid({ endTime: new Date(NOW - 1000).toISOString() }), NOW).endTime).toBeDefined();
    expect(validateListing(valid({ endTime: new Date(NOW + 31 * 86400000).toISOString() }), NOW).endTime).toBeDefined();
  });
  it("requires 1–12 photos", () => {
    expect(validateListing(valid({ photoUrls: [] }), NOW).photoUrls).toBeDefined();
    expect(validateListing(valid({ photoUrls: Array(13).fill("x") }), NOW).photoUrls).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/listings/validation.test.ts`
Expected: FAIL — cannot find module `validation`.

- [ ] **Step 3: Write the module**

Create `src/lib/listings/validation.ts`:

```ts
export interface ListingInput {
  make: string; model: string; year: number; variant: string;
  odometerKm: number; grade: "A" | "B" | "C" | "D" | "E"; color: string;
  mechanicalNotes: string; appraisalNotes: string; photoUrls: string[];
  startingPrice: number; reservePrice: number; buyNowPrice: number | null;
  endTime: string; // ISO 8601
}

export type ValidationErrors = Partial<Record<keyof ListingInput, string>>;

const DAY = 86_400_000;

export function validateListing(i: ListingInput, nowMs: number = Date.now()): ValidationErrors {
  const e: ValidationErrors = {};
  const yearMax = new Date(nowMs).getFullYear() + 1;

  if (!i.make?.trim()) e.make = "Make is required";
  if (!i.model?.trim()) e.model = "Model is required";
  if (!Number.isInteger(i.year) || i.year < 1980 || i.year > yearMax)
    e.year = `Year must be between 1980 and ${yearMax}`;
  if (!Number.isInteger(i.odometerKm) || i.odometerKm < 0)
    e.odometerKm = "Odometer must be 0 or more";
  if (!["A", "B", "C", "D", "E"].includes(i.grade)) e.grade = "Grade must be A–E";

  if (!Number.isInteger(i.startingPrice) || i.startingPrice <= 0)
    e.startingPrice = "Starting price must be greater than 0";
  if (!Number.isInteger(i.reservePrice) || i.reservePrice < i.startingPrice)
    e.reservePrice = "Reserve must be at least the starting price";
  if (i.buyNowPrice !== null && (!Number.isInteger(i.buyNowPrice) || i.buyNowPrice <= i.reservePrice))
    e.buyNowPrice = "Buy-now must be greater than the reserve";

  const end = Date.parse(i.endTime);
  if (Number.isNaN(end)) e.endTime = "Choose an end date and time";
  else if (end <= nowMs) e.endTime = "End time must be in the future";
  else if (end > nowMs + 30 * DAY) e.endTime = "End time must be within 30 days";

  const n = i.photoUrls?.length ?? 0;
  if (n < 1) e.photoUrls = "Add at least one photo";
  else if (n > 12) e.photoUrls = "No more than 12 photos";

  return e;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/listings/validation.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/listings/validation.ts tests/listings/validation.test.ts
git commit -m "Add listing input validation module"
```

---

### Task 3: Service-role client + listing service layer (TDD)

**Files:**
- Create: `src/lib/supabase/service.ts`, `src/lib/listings/service.ts`
- Test: `tests/listings/service.test.ts`

**Interfaces:**
- Consumes: `validateListing`, `ListingInput` (Task 2); the three RPCs (Task 1).
- Produces:
  - `serviceClient()` → a `supabase-js` client built with the service-role key (server-only).
  - `type ServiceResult = { ok: true; auctionId: string } | { ok: false; errors: ValidationErrors & { _form?: string } }`
  - `createDraft(dealerId: string, input: ListingInput): Promise<ServiceResult>`
  - `updateDraft(dealerId: string, auctionId: string, input: ListingInput): Promise<ServiceResult>`
  - `publishListing(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/listings/service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { cleanupDrafts } from "../helpers/db";
import { createDraft, updateDraft, publishListing } from "../../src/lib/listings/service";
import { ListingInput } from "../../src/lib/listings/validation";

const SELLER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
function input(o: Partial<ListingInput> = {}): ListingInput {
  return {
    make: "Toyota", model: "Hilux", year: 2021, variant: "SR5", odometerKm: 40000,
    grade: "A", color: "White", mechanicalNotes: "", appraisalNotes: "",
    photoUrls: ["https://img/1.jpg"], startingPrice: 1000000, reservePrice: 1200000,
    buyNowPrice: 1500000, endTime: new Date(Date.now() + 2 * 86400000).toISOString(), ...o,
  };
}

describe("listing service", () => {
  beforeEach(cleanupDrafts);

  it("rejects invalid input before hitting the DB", async () => {
    const r = await createDraft(SELLER, input({ make: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.make).toBeDefined();
  });

  it("creates a draft and returns its id", async () => {
    const r = await createDraft(SELLER, input());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.auctionId).toMatch(/[0-9a-f-]{36}/);
  });

  it("publishes a valid draft", async () => {
    const c = await createDraft(SELLER, input());
    if (!c.ok) throw new Error("setup failed");
    const r = await publishListing(SELLER, c.auctionId);
    expect(r).toEqual({ ok: true });
  });

  it("reports a non-owner publish as a reason", async () => {
    const c = await createDraft(SELLER, input());
    if (!c.ok) throw new Error("setup failed");
    const r = await publishListing(OTHER, c.auctionId);
    expect(r).toEqual({ ok: false, reason: "not_owner" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/listings/service.test.ts`
Expected: FAIL — cannot find module `service`.

- [ ] **Step 3: Write the service-role client**

Create `src/lib/supabase/service.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

// Server-only: uses the service-role key. NEVER import this into a "use client" module.
export function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
```

- [ ] **Step 4: Write the service layer**

Create `src/lib/listings/service.ts`:

```ts
import { serviceClient } from "@/lib/supabase/service";
import { validateListing, ListingInput, ValidationErrors } from "./validation";

export type ServiceResult =
  | { ok: true; auctionId: string }
  | { ok: false; errors: ValidationErrors & { _form?: string } };

function rpcArgs(input: ListingInput) {
  return {
    p_make: input.make, p_model: input.model, p_year: input.year, p_variant: input.variant,
    p_odometer_km: input.odometerKm, p_grade: input.grade, p_color: input.color,
    p_mechanical_notes: input.mechanicalNotes, p_appraisal_notes: input.appraisalNotes,
    p_photo_urls: input.photoUrls, p_starting_price: input.startingPrice,
    p_reserve_price: input.reservePrice, p_buy_now_price: input.buyNowPrice,
    p_end_time: input.endTime,
  };
}

export async function createDraft(dealerId: string, input: ListingInput): Promise<ServiceResult> {
  const errors = validateListing(input);
  if (Object.keys(errors).length) return { ok: false, errors };
  const { data, error } = await serviceClient().rpc("create_draft_listing", {
    p_dealer_id: dealerId, ...rpcArgs(input),
  });
  if (error) return { ok: false, errors: { _form: "Could not save draft" } };
  return { ok: true, auctionId: data as string };
}

export async function updateDraft(dealerId: string, auctionId: string, input: ListingInput): Promise<ServiceResult> {
  const errors = validateListing(input);
  if (Object.keys(errors).length) return { ok: false, errors };
  const { data, error } = await serviceClient().rpc("update_draft_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId, ...rpcArgs(input),
  });
  if (error) return { ok: false, errors: { _form: "Could not update draft" } };
  if (data !== "updated") return { ok: false, errors: { _form: data as string } };
  return { ok: true, auctionId };
}

export async function publishListing(dealerId: string, auctionId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await serviceClient().rpc("publish_listing", {
    p_auction_id: auctionId, p_dealer_id: dealerId,
  });
  if (error) return { ok: false, reason: "error" };
  return data === "live" ? { ok: true } : { ok: false, reason: data as string };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/listings/service.test.ts`
Expected: PASS (4/4). (Requires local Supabase running with Task 1's migration applied.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase/service.ts src/lib/listings/service.ts tests/listings/service.test.ts
git commit -m "Add service-role client and listing service layer"
```

---

### Task 4: R2 presign helper + upload endpoint (TDD)

**Files:**
- Create: `src/lib/r2.ts`, `src/app/api/uploads/presign/route.ts`
- Modify: `.env.local.example`
- Test: `tests/listings/presign.test.ts`

**Interfaces:**
- Consumes: `getDealerId` (`src/lib/session.ts`).
- Produces:
  - `r2Configured(): boolean`
  - `presignUpload(key: string, contentType: string): Promise<string>`
  - `publicUrl(key: string): string`
  - `POST /api/uploads/presign` body `{ filename: string; contentType: string; size: number }` → `200 { uploadUrl, publicUrl }` | `401` | `503 { error: "r2_not_configured" }` | `400 { error: "invalid_file" }`.

- [ ] **Step 1: Install the R2 SDK**

Run: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

- [ ] **Step 2: Write the failing test (R2 + session mocked)**

Create `tests/listings/presign.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/r2", () => ({
  r2Configured: vi.fn(() => true),
  presignUpload: vi.fn(async () => "https://r2.example/put-url"),
  publicUrl: vi.fn((k: string) => `https://cdn.example/${k}`),
}));
vi.mock("../../src/lib/session", () => ({ getDealerId: vi.fn(async () => "dealer-1") }));

import { POST } from "../../src/app/api/uploads/presign/route";
import * as r2 from "../../src/lib/r2";
import * as session from "../../src/lib/session";

function req(body: unknown) {
  return new Request("http://localhost/api/uploads/presign", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/uploads/presign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 when not logged in", async () => {
    vi.mocked(session.getDealerId).mockResolvedValueOnce(null);
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 1000 }));
    expect(res.status).toBe(401);
  });

  it("503 when R2 is not configured", async () => {
    vi.mocked(r2.r2Configured).mockReturnValueOnce(false);
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 1000 }));
    expect(res.status).toBe(503);
  });

  it("400 for a non-image content type", async () => {
    const res = await POST(req({ filename: "a.pdf", contentType: "application/pdf", size: 1000 }));
    expect(res.status).toBe(400);
  });

  it("400 for a file over 10 MB", async () => {
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 11 * 1024 * 1024 }));
    expect(res.status).toBe(400);
  });

  it("200 with upload + public URLs for a valid request", async () => {
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 1000 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadUrl).toBe("https://r2.example/put-url");
    expect(body.publicUrl).toMatch(/^https:\/\/cdn\.example\/listings\//);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/listings/presign.test.ts`
Expected: FAIL — cannot find module `route`.

- [ ] **Step 4: Write the R2 helper**

Create `src/lib/r2.ts`:

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_BASE_URL
  );
}

function client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export async function presignUpload(key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, ContentType: contentType });
  return getSignedUrl(client(), cmd, { expiresIn: 600 });
}

export function publicUrl(key: string): string {
  return `${process.env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "")}/${key}`;
}
```

- [ ] **Step 5: Write the route**

Create `src/app/api/uploads/presign/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDealerId } from "@/lib/session";
import { r2Configured, presignUpload, publicUrl } from "@/lib/r2";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const dealerId = await getDealerId();
  if (!dealerId) return NextResponse.json({ error: "no_dealer" }, { status: 401 });
  if (!r2Configured()) return NextResponse.json({ error: "r2_not_configured" }, { status: 503 });

  let body: { filename?: unknown; contentType?: unknown; size?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }

  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const size = Number(body.size);
  const filename = typeof body.filename === "string" ? body.filename : "upload";
  if (!contentType.startsWith("image/")) return NextResponse.json({ error: "invalid_file" }, { status: 400 });
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES)
    return NextResponse.json({ error: "invalid_file" }, { status: 400 });

  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `listings/${crypto.randomUUID()}-${safe}`;
  const uploadUrl = await presignUpload(key, contentType);
  return NextResponse.json({ uploadUrl, publicUrl: publicUrl(key) });
}
```

- [ ] **Step 6: Document the R2 env vars**

Append to `.env.local.example`:

```bash
# Cloudflare R2 (listing photo uploads). Without these, the photo step returns 503.
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/listings/presign.test.ts`
Expected: PASS (5/5).

- [ ] **Step 8: Commit**

```bash
git add src/lib/r2.ts src/app/api/uploads/presign/route.ts .env.local.example tests/listings/presign.test.ts package.json package-lock.json
git commit -m "Add R2 presigned upload endpoint"
```

---

### Task 5: Sell form, uploader, and create/update actions

**Files:**
- Create: `src/app/sell/page.tsx`, `src/app/sell/[id]/page.tsx`, `src/app/sell/actions.ts`, `src/components/ListingForm.tsx`, `src/components/PhotoUploader.tsx`, `src/components/Header.tsx`
- Modify: `src/lib/auctions.ts` (add `getAuctionById`), `src/app/page.tsx` (render `Header`)

**Interfaces:**
- Consumes: `createDraft`/`updateDraft` (Task 3), `validateListing`/`ListingInput` (Task 2), `getDealerId` (session), `dollarsToCents`/`formatNZD` (`src/lib/money.ts`), the presign route (Task 4).
- Produces:
  - `getAuctionById(id: string)` in `src/lib/auctions.ts` → auction row with `vehicle` + `seller` joins, including drafts, or `null`.
  - Server actions `createDraftAction(prev, formData)` and `updateDraftAction(prev, formData)` for `useActionState`, each returning `{ errors?: ValidationErrors & { _form?: string } }` or redirecting on success.

- [ ] **Step 1: Add `getAuctionById`**

In `src/lib/auctions.ts`, add:

```ts
export async function getAuctionById(id: string) {
  const sb = await serverClient();
  const { data } = await sb.from("auctions")
    .select("*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)")
    .eq("id", id).maybeSingle();
  return data;
}
```

- [ ] **Step 2: Write the server actions**

Create `src/app/sell/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { createDraft, updateDraft } from "@/lib/listings/service";
import { ListingInput, ValidationErrors } from "@/lib/listings/validation";
import { dollarsToCents } from "@/lib/money";

export type FormState = { errors?: ValidationErrors & { _form?: string } };

function parse(formData: FormData): ListingInput {
  const dollars = (k: string) => dollarsToCents(Number(formData.get(k) || 0));
  const buyNowRaw = String(formData.get("buyNowPrice") || "").trim();
  return {
    make: String(formData.get("make") || ""),
    model: String(formData.get("model") || ""),
    year: Number(formData.get("year") || 0),
    variant: String(formData.get("variant") || ""),
    odometerKm: Number(formData.get("odometerKm") || 0),
    grade: String(formData.get("grade") || "A") as ListingInput["grade"],
    color: String(formData.get("color") || ""),
    mechanicalNotes: String(formData.get("mechanicalNotes") || ""),
    appraisalNotes: String(formData.get("appraisalNotes") || ""),
    photoUrls: formData.getAll("photoUrls").map(String).filter(Boolean),
    startingPrice: dollars("startingPrice"),
    reservePrice: dollars("reservePrice"),
    buyNowPrice: buyNowRaw ? dollarsToCents(Number(buyNowRaw)) : null,
    endTime: new Date(String(formData.get("endTime") || "")).toISOString(),
  };
}

export async function createDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const r = await createDraft(dealerId, parse(formData));
  if (!r.ok) return { errors: r.errors };
  redirect(`/auction/${r.auctionId}`);
}

export async function updateDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await updateDraft(dealerId, auctionId, parse(formData));
  if (!r.ok) return { errors: r.errors };
  redirect(`/auction/${auctionId}`);
}
```

- [ ] **Step 3: Write the photo uploader**

Create `src/components/PhotoUploader.tsx`:

```tsx
"use client";

import { useState } from "react";

export function PhotoUploader({ initial = [] }: { initial?: string[] }) {
  const [urls, setUrls] = useState<string[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setError(null);
    setBusy(true);
    try {
      for (const file of files) {
        const presign = await fetch("/api/uploads/presign", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
        });
        if (!presign.ok) {
          const b = await presign.json().catch(() => ({}));
          setError(b.error === "r2_not_configured" ? "Photo uploads aren't configured." : "Upload rejected.");
          continue;
        }
        const { uploadUrl, publicUrl } = await presign.json();
        const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
        if (!put.ok) { setError("Upload failed, try again."); continue; }
        setUrls((prev) => [...prev, publicUrl]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {urls.map((u) => (
        <input key={u} type="hidden" name="photoUrls" value={u} />
      ))}
      <div className="flex flex-wrap gap-2">
        {urls.map((u) => (
          <div key={u} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="h-20 w-20 rounded object-cover border border-zinc-700" />
            <button type="button" onClick={() => setUrls((p) => p.filter((x) => x !== u))}
              className="absolute -top-2 -right-2 rounded-full bg-red-600 text-white w-5 h-5 text-xs">×</button>
          </div>
        ))}
      </div>
      <input type="file" accept="image/*" multiple onChange={onSelect} disabled={busy}
        className="text-sm text-zinc-300" />
      {busy && <p className="text-xs text-zinc-400">Uploading…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Write the listing form**

Create `src/components/ListingForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { PhotoUploader } from "./PhotoUploader";
import type { FormState } from "@/app/sell/actions";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Initial = {
  auctionId?: string; make?: string; model?: string; year?: number; variant?: string;
  odometerKm?: number; grade?: string; color?: string; mechanicalNotes?: string;
  appraisalNotes?: string; photoUrls?: string[]; startingPrice?: string; reservePrice?: string;
  buyNowPrice?: string; endTime?: string;
};

export function ListingForm({ action, initial = {}, submitLabel }:
  { action: Action; initial?: Initial; submitLabel: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  const err = state.errors ?? {};
  const field = "w-full rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-white";

  return (
    <form action={formAction} className="space-y-4 max-w-xl">
      {initial.auctionId && <input type="hidden" name="auctionId" value={initial.auctionId} />}
      {err._form && <p className="text-red-400 text-sm">{err._form}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1"><span className="text-xs text-zinc-400">Make</span>
          <input name="make" defaultValue={initial.make} className={field} />
          {err.make && <span className="text-xs text-red-400">{err.make}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Model</span>
          <input name="model" defaultValue={initial.model} className={field} />
          {err.model && <span className="text-xs text-red-400">{err.model}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Year</span>
          <input name="year" type="number" defaultValue={initial.year} className={field} />
          {err.year && <span className="text-xs text-red-400">{err.year}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Variant</span>
          <input name="variant" defaultValue={initial.variant} className={field} /></label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Odometer (km)</span>
          <input name="odometerKm" type="number" defaultValue={initial.odometerKm} className={field} />
          {err.odometerKm && <span className="text-xs text-red-400">{err.odometerKm}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Grade</span>
          <select name="grade" defaultValue={initial.grade ?? "A"} className={field}>
            {["A", "B", "C", "D", "E"].map((g) => <option key={g}>{g}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Color</span>
          <input name="color" defaultValue={initial.color} className={field} /></label>
      </div>

      <label className="block space-y-1"><span className="text-xs text-zinc-400">Mechanical notes</span>
        <textarea name="mechanicalNotes" defaultValue={initial.mechanicalNotes} className={field} /></label>
      <label className="block space-y-1"><span className="text-xs text-zinc-400">Appraisal notes</span>
        <textarea name="appraisalNotes" defaultValue={initial.appraisalNotes} className={field} /></label>

      <div className="grid grid-cols-3 gap-3">
        <label className="space-y-1"><span className="text-xs text-zinc-400">Starting ($)</span>
          <input name="startingPrice" type="number" defaultValue={initial.startingPrice} className={field} />
          {err.startingPrice && <span className="text-xs text-red-400">{err.startingPrice}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Reserve ($)</span>
          <input name="reservePrice" type="number" defaultValue={initial.reservePrice} className={field} />
          {err.reservePrice && <span className="text-xs text-red-400">{err.reservePrice}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Buy now ($, optional)</span>
          <input name="buyNowPrice" type="number" defaultValue={initial.buyNowPrice} className={field} />
          {err.buyNowPrice && <span className="text-xs text-red-400">{err.buyNowPrice}</span>}</label>
      </div>

      <label className="block space-y-1"><span className="text-xs text-zinc-400">Auction ends</span>
        <input name="endTime" type="datetime-local" defaultValue={initial.endTime} className={field} />
        {err.endTime && <span className="text-xs text-red-400">{err.endTime}</span>}</label>

      <div className="space-y-1"><span className="text-xs text-zinc-400">Photos</span>
        <PhotoUploader initial={initial.photoUrls} />
        {err.photoUrls && <span className="text-xs text-red-400">{err.photoUrls}</span>}</div>

      <button type="submit" disabled={pending}
        className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-semibold text-white disabled:opacity-50">
        {pending ? "Saving…" : submitLabel}</button>
    </form>
  );
}
```

- [ ] **Step 5: Write the header and the create/edit pages**

Create `src/components/Header.tsx`:

```tsx
import Link from "next/link";
import { getDealerId } from "@/lib/session";

export async function Header() {
  const dealerId = await getDealerId();
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <Link href="/" className="font-semibold text-white">Wholesale Dealer Auctions</Link>
      {dealerId && (
        <Link href="/sell" className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
          Sell a vehicle
        </Link>
      )}
    </header>
  );
}
```

Create `src/app/sell/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { ListingForm } from "@/components/ListingForm";
import { createDraftAction } from "./actions";

export default async function SellPage() {
  if (!(await getDealerId())) redirect("/login");
  return (
    <main className="px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">List a vehicle</h1>
      <ListingForm action={createDraftAction} submitLabel="Save draft" />
    </main>
  );
}
```

Create `src/app/sell/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { getAuctionById } from "@/lib/auctions";
import { ListingForm } from "@/components/ListingForm";
import { updateDraftAction } from "../actions";

export default async function EditDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const a = await getAuctionById(id);
  if (!a || a.status !== "draft" || a.seller_dealer_id !== dealerId) notFound();
  const v = a.vehicle;
  return (
    <main className="px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">Edit draft</h1>
      <ListingForm action={updateDraftAction} submitLabel="Update draft" initial={{
        auctionId: a.id, make: v.make, model: v.model, year: v.year, variant: v.variant ?? "",
        odometerKm: v.odometer_km, grade: v.grade, color: v.color ?? "",
        mechanicalNotes: v.mechanical_notes ?? "", appraisalNotes: v.appraisal_notes ?? "",
        photoUrls: v.photo_urls ?? [],
        startingPrice: String(a.starting_price / 100), reservePrice: String(a.reserve_price / 100),
        buyNowPrice: a.buy_now_price ? String(a.buy_now_price / 100) : "",
        endTime: new Date(a.end_time).toISOString().slice(0, 16),
      }} />
    </main>
  );
}
```

- [ ] **Step 6: Render the header on the home page**

In `src/app/page.tsx`, import and render `<Header />` above the grid:

```tsx
import { Header } from "@/components/Header";
// ...inside the returned JSX, as the first child of the page wrapper:
//   <Header />
```

- [ ] **Step 7: Verify the build type-checks**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/app/sell src/components/ListingForm.tsx src/components/PhotoUploader.tsx src/components/Header.tsx src/lib/auctions.ts src/app/page.tsx
git commit -m "Add sell form, photo uploader, and draft create/update actions"
```

---

### Task 6: Owner preview + publish

**Files:**
- Create: `src/components/PublishPanel.tsx`
- Modify: `src/app/auction/[id]/page.tsx`, `src/app/sell/actions.ts`

**Interfaces:**
- Consumes: `getAuctionById` (Task 5), `publishListing` (Task 3), `getDealerId`.
- Produces: server action `publishAction(formData)` (reads cookie, calls `publishListing`, redirects on success or returns a reason); `PublishPanel` client component.

- [ ] **Step 1: Add the publish action**

Append to `src/app/sell/actions.ts`:

```ts
import { publishListing } from "@/lib/listings/service";

const PUBLISH_MESSAGES: Record<string, string> = {
  not_owner: "You can only publish your own draft.",
  not_draft: "This listing is already published.",
  end_in_past: "Your auction end time is in the past — edit the draft and pick a new time.",
  no_photos: "Add at least one photo before publishing.",
  error: "Could not publish, try again.",
};

export async function publishAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await publishListing(dealerId, auctionId);
  if (r.ok) redirect(`/auction/${auctionId}`);
  return { error: PUBLISH_MESSAGES[r.reason ?? "error"] ?? "Could not publish." };
}
```

- [ ] **Step 2: Write the publish panel**

Create `src/components/PublishPanel.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import Link from "next/link";
import { publishAction } from "@/app/sell/actions";

export function PublishPanel({ auctionId }: { auctionId: string }) {
  const [state, action, pending] = useActionState(publishAction, {});
  return (
    <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-6 space-y-4">
      <div className="text-amber-300 text-sm font-semibold">Draft — not yet live</div>
      <p className="text-sm text-zinc-300">Review the details. Publishing starts the auction now and makes it visible to all dealers.</p>
      <div className="flex gap-3">
        <form action={action}>
          <input type="hidden" name="auctionId" value={auctionId} />
          <button type="submit" disabled={pending}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-semibold text-white disabled:opacity-50">
            {pending ? "Publishing…" : "Publish auction"}</button>
        </form>
        <Link href={`/sell/${auctionId}`} className="rounded border border-zinc-600 px-4 py-2 text-sm text-zinc-200">Edit draft</Link>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Branch the auction detail page for drafts**

In `src/app/auction/[id]/page.tsx`, replace the auction fetch with `getAuctionById` and add the draft branch before the existing live rendering. The page already awaits `params` and reads the dealer cookie. Add:

```tsx
import { getAuctionById } from "@/lib/auctions";
import { PublishPanel } from "@/components/PublishPanel";
// ...
const a = await getAuctionById(id);
if (!a) notFound();
const dealerId = await getDealerId();
if (a.status === "draft") {
  if (a.seller_dealer_id !== dealerId) notFound();        // drafts are private
  // render the same vehicle header/details, but PublishPanel instead of BidPanel:
  //   <PublishPanel auctionId={a.id} />
}
// else: existing live rendering (BidPanel) unchanged.
```

Keep the existing vehicle/details markup shared; only the right-hand panel differs (`PublishPanel` for an owner's draft, `BidPanel` otherwise). Do not open a realtime subscription in the draft branch.

- [ ] **Step 4: Verify type-check and a manual smoke**

Run: `npx tsc --noEmit`
Expected: exit 0.
Manual: with local Supabase up and a `dealer_id` cookie set, visit `/sell`, save a draft, land on `/auction/<id>` showing the "Draft — not yet live" panel; a different dealer visiting that URL gets a 404.

- [ ] **Step 5: Commit**

```bash
git add src/components/PublishPanel.tsx src/app/auction/[id]/page.tsx src/app/sell/actions.ts
git commit -m "Add owner draft preview and publish flow"
```

---

### Task 7: End-to-end create→publish smoke test

**Files:**
- Create: `tests/e2e/listing.spec.ts`

**Interfaces:**
- Consumes: the running dev server + seeded DB + Slice 1 `globalSetup` reset. Requires R2 creds to exercise the photo step.

- [ ] **Step 1: Write the e2e test**

Create `tests/e2e/listing.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

const R2_READY = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET);

test("dealer creates a draft, previews it, and publishes it live", async ({ page }) => {
  test.skip(!R2_READY, "R2 not configured — skipping the photo-dependent create flow");

  await page.goto("/login");
  await page.getByRole("button").first().click();
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: "Sell a vehicle" }).click();
  await expect(page).toHaveURL("/sell");

  await page.getByLabel("Make").fill("Toyota");
  await page.getByLabel("Model").fill("Hilux");
  await page.getByLabel("Year").fill("2021");
  await page.getByLabel("Odometer (km)").fill("40000");
  await page.getByLabel("Starting ($)").fill("10000");
  await page.getByLabel("Reserve ($)").fill("12000");
  const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16);
  await page.getByLabel("Auction ends").fill(inTwoDays);

  // Upload a small generated image.
  await page.setInputFiles('input[type="file"]', {
    name: "car.png", mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100", "hex"),
  });
  await expect(page.locator('img[alt=""]')).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft — not yet live")).toBeVisible();

  await page.getByRole("button", { name: "Publish auction" }).click();
  await expect(page.getByRole("button", { name: "Place bid" })).toBeVisible({ timeout: 8000 });
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/listing.spec.ts`
Expected: PASS if R2 is configured, otherwise SKIPPED with the stated reason. The other e2e specs continue to pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/listing.spec.ts
git commit -m "Add e2e test for the listing create and publish flow"
```

---

## Self-Review

**Spec coverage:**
- §4 data model (draft enum, nullable start_time) → Task 1. ✓
- §5 write path + 3 RPCs + validation mirrored in publish → Tasks 1, 2, 3. ✓
- §6 screens (/sell, /sell/[id], preview reuse, nav) → Tasks 5, 6. ✓
- §7 R2 presigned upload + env + legible failure → Task 4. ✓
- §8 error handling (field errors, publish reasons, presign 503/400, owner 404) → Tasks 3–6. ✓
- §9 testing (unit validation + presign, integration RPCs + service, e2e, invariant) → Tasks 1–7. ✓ (draft-excluded-from-live invariant asserted in Task 1 Step 1).

**Placeholder scan:** No TBD/TODO; every code step shows real code. The auction-page edit (Task 6 Step 3) is described as a targeted insertion against existing Slice 1 code rather than a full rewrite — the surrounding file is the implementer's to preserve.

**Type consistency:** `ListingInput` fields and the `p_*` RPC params line up across Tasks 1–3 and the `parse()` mapper in Task 5; `ServiceResult`/`FormState` error shapes are consistent across service, actions, and form; `publishListing` reasons map 1:1 to `PUBLISH_MESSAGES` and the RPC return strings.

**Out of scope (correctly absent):** my-listings dashboard, editing/cancelling live auctions, RLS row-level draft privacy (app-gated for this slice), search/filter, real payments.
