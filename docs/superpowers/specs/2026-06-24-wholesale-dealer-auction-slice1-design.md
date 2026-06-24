# Wholesale Dealer Auction Platform — Slice 1 Design

**Date:** 2026-06-24
**Status:** Design — approved for documentation, not yet implemented
**Author:** Brainstormed with Claude Code

---

## 1. Product context

A private B2B wholesale vehicle marketplace for New Zealand. Licensed motor-vehicle
dealers list trade-ins, ex-lease vehicles, finance repossessions, and aged stock for
other dealers to bid on in timed auctions.

**Why it's plausible:** NZ's largest incumbent auction site charges ~$350/listing and
recently added a ~$100 buyer fee, pushing dealers away. Trade Me lacks dealer-to-dealer
transparency. Many smaller dealers still rely on Facebook groups, personal contacts, and
physical auctions. A cleaner, faster, lower-fee, dealer-only platform fills a real gap and
nudges grey-market flippers toward registering as dealers.

**Intended business model (for later slices, not built now):**
- Seller fee: $200 per successfully sold vehicle.
- Buyer fee: $20 success fee on a won auction.
- Future revenue: featured listings, transport coordination, finance partnerships,
  inspections, subscription tiers, DMS API integration.

---

## 2. Goal of this first build

A **clickable demo / prototype** to put in front of real dealers, validate the idea, and
pitch. The auction *experience* must feel completely real, but payments and dealer
verification are **simulated** — no live Stripe, no real ID/NZBN/license checks. This keeps
us out of legal/compliance scope while making the core experience convincing.

The demo must support **real multi-device live bidding**: two people on two phones can bid
against each other and see updates instantly. This is the hero moment for live pitches.

---

## 3. Platform decomposition

The full platform is ~6 independent subsystems. Each gets its own spec → plan → build
cycle. Build order, each demoable on its own:

| Slice | Scope | Status |
|---|---|---|
| **1. Hero auction flow** | Pick-a-dealer login → browse live auctions → vehicle detail → real-time bidding (proxy bids, anti-snipe, outbid alerts) → win → simulated settlement. Seeded inventory. | **This spec** |
| 2. Selling side | Create/upload a listing (photos, condition grade, reserve, buy-now), seller dashboard | Later |
| 3. Homepage & discovery | Ending-soon, recently-sold, premium dealers, market-trends, search/filter | Later |
| 4. Trust & polish | Ratings, verification badges, watchlist, notifications, invoices | Later |
| 5+. Real systems | Live Stripe, real NZBN/license/CarJam verification, AI pricing, mobile app | Post-validation |

**Rationale for building Slice 1 first:** it de-risks the only technically hard part
(real-time, concurrent, proxy/anti-snipe bidding), and it *is* the pitch — a dealer feeling
a live bid land on their phone is what sells the thesis. Sellers are an easy sell (lower
fees); buyer trust is the hard part, so the buyer experience comes first. Seeded inventory
substitutes for listing-creation until Slice 2.

---

## 4. Tech stack

**Chosen: Next.js (App Router) + Supabase (Postgres + Realtime + Auth) + Vercel, with
Cloudflare R2 for media. Tailwind CSS for styling.**

### Why this stack
- **One managed backend.** Supabase provides Postgres, a realtime layer, and auth in a
  single service — no custom WebSocket server to operate.
- **Bid integrity.** Bids are placed through a single atomic Postgres function, so
  simultaneous bids cannot corrupt the price (transactional, relational integrity).
- **Realtime.** Supabase Realtime pushes every price change to all connected clients.
- **Phone-friendly workflow.** Everything lives in the repo + managed dashboards, which
  suits running implementations from Claude Code web on a phone. No servers to babysit.
- **Low lock-in / cheap exit ramp.** Supabase is just Postgres + open-source parts, and the
  app is standard Next.js. If costs ever bite at large scale, we can migrate to plain
  managed Postgres or a self-hosted box without rewriting the data model or app.

### Cost (ballpark — verify current pricing before relying on it)
- Demo/pitching: ~$0, realistically Supabase Pro $25/mo (free projects pause on inactivity).
- Early MVP: ~$45/mo (Supabase Pro $25 + Vercel Pro $20).
- Growing: ~$100–300/mo, driven by realtime connections + media bandwidth.
- Large scale: self-hosting becomes cheaper per-unit but costs DevOps time.

### Rejected alternatives
- **Firebase/Firestore:** per-read/write pricing balloons under live-auction read volume;
  NoSQL makes correct proxy-bid resolution and anti-snipe error-prone.
- **Custom Node/Socket.io + VPS:** cheapest raw compute, most ops burden; Vercel doesn't
  host persistent WebSockets well; fights the phone workflow.

### Cost decision baked in now
Vehicle photos/videos are the biggest bandwidth cost on an image-heavy marketplace. Store
media on **Cloudflare R2 (zero egress fees)** from day one.

---

## 5. Data model (Postgres / Supabase)

- **`dealers`** — `id`, `business_name`, `dealer_license_no` (fake), `region`, `rating`,
  `is_verified` (simulated badge), `initials`/avatar.
- **`vehicles`** — `id`, `make`, `model`, `year`, `variant`, `odometer_km`, `rego`, `vin`,
  `grade` (A–E), `color`, `mechanical_notes`, `appraisal_notes`, `photo_urls[]`.
- **`auctions`** — `id`, `vehicle_id`, `seller_dealer_id`, `start_time`, `end_time`,
  `starting_price`, `reserve_price`, `buy_now_price` (nullable), `bid_increment`,
  `anti_snipe_seconds`, `status` (`live` | `ended` | `sold` | `passed`),
  `current_bid` (cached), `current_winner_dealer_id` (cached).
- **`bids`** — `id`, `auction_id`, `bidder_dealer_id`, `amount`, `max_amount` (nullable,
  for proxy), `is_auto` (proxy-generated), `created_at`.
- **`settlements`** (simulated) — `id`, `auction_id`, `sale_price`, `seller_fee` (200),
  `buyer_fee` (20), `status`.

---

## 6. The bid engine (the heart of the system)

A single server-side function `place_bid(auction_id, dealer_id, max_amount)` runs in one
transaction and is the **only** way a bid is created. It is the single source of truth;
clients never write bids directly.

**Responsibilities:**
1. **Reject invalid bids** — auction not `live`/ended, or amount below
   `current_bid + bid_increment`.
2. **Proxy resolution** — the bidder submits a maximum. The system places the minimum bid
   needed on their behalf. When two proxy bids collide, the higher max wins at
   `min(loser_max + increment, winner_max)`.
3. **Anti-snipe extension** — if the bid lands within the anti-snipe window (e.g. last 30s),
   extend `end_time` by `anti_snipe_seconds`.
4. **Update cached state** — write the new `current_bid` / `current_winner_dealer_id`.
5. **Return authoritative state** to the caller.

Supabase Realtime then broadcasts the change to every connected client.

---

## 7. Pages & components

**Pages**
- `/login` — pick-a-dealer (no password; simulated demo). Selection stored in a cookie.
- `/` — live auctions grid: vehicle photo, current bid, live countdown, bid count,
  "ending soon" emphasis.
- `/auction/[id]` — vehicle detail + bid panel (current bid, your max-bid input, place-bid,
  your status: *winning / outbid / reserve not met*), live bid history, anti-snipe countdown
  that visibly jumps when extended.
- `/won/[id]` — simulated settlement: sale price, $200 seller fee + $20 buyer fee,
  "settlement arranged" confirmation.

**Key components**
- `AuctionCard`, `CountdownTimer`, `BidPanel`, `BidHistory`, `DealerBadge`, `BidStatusPill`.

---

## 8. Realtime & client state

- Each open auction subscribes to its bids/price; the grid subscribes to all live auctions.
- Optimistic UI on the user's own bid, reconciled against the function's authoritative
  response.
- Auto-reconnect on socket drop; on reconnect, refetch authoritative auction state.

---

## 9. Error & edge handling

All of these are explicit, friendly UI states — never silent failures:
- Bid too low (below current + increment).
- Auction just ended (bid arrived after `end_time`).
- Already winning (no-op with clear messaging).
- Reserve not met (shown distinctly from "winning").
- Lost connection (banner + auto-reconnect).

Because the server function is the single source of truth, client race conditions cannot
corrupt the price.

---

## 10. Testing strategy

- **Bid engine first (TDD).** `place_bid` gets real tests before implementation: increment
  enforcement, proxy resolution, two-proxy collision, anti-snipe extension, ended-auction
  rejection, reserve logic. This is where bugs are costly.
- **UI smoke test.** Happy-path: log in as a dealer, open an auction, place a winning bid,
  reach the settlement screen.

---

## 11. Visual direction

Bloomberg + Bring a Trailer: dark charcoal background, white vehicle cards, green/red bid
indicators, monospaced numerals for prices and countdowns. Real visual polish is deferred
to the `frontend-design` skill in a later pass so we don't gold-plate before the engine
works.

---

## 12. Out of scope for Slice 1

Listing creation/upload, dashboards/analytics, search/filter, ratings/verification badges
(beyond seeded display), watchlist, notifications, real Stripe payments, real dealer
verification (NZBN/license/CarJam/NZTA), AI pricing, native mobile app.

---

## 13. Workflow note

Future implementations are intended to run from Claude Code web on a phone. Keep files
small and well-bounded, prefer managed services over self-hosted infra, and keep the repo
the single source of truth (the `.claude/settings.json` plugin config is already committed
so the web environment matches local).
