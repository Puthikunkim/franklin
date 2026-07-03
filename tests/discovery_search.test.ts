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
