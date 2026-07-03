import type { SupabaseClient } from "@supabase/supabase-js";

const AUCTION_WITH_JOINS =
  "*, vehicle:vehicles(*), seller:dealers!auctions_seller_dealer_id_fkey(*)";

export const REGIONS = ["Auckland", "Hamilton", "Wellington", "Christchurch", "Tauranga"];
export const SORT_OPTIONS = [
  { value: "ending_soon", label: "Ending soon" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "newest", label: "Newest" },
];

const VALID_GRADES = ["A", "B", "C", "D", "E"];
const VALID_SORTS = SORT_OPTIONS.map((s) => s.value);

export type AuctionFilters = {
  q?: string;
  grades?: string[];
  minPrice?: number; // cents
  maxPrice?: number; // cents
  region?: string;
  sort?: string;
};

type SP = Record<string, string | string[] | undefined>;

function firstStr(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
}
function posIntDollars(v: string | string[] | undefined): number | undefined {
  const s = firstStr(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// Parse URL search params into a validated filter object. Garbage is dropped
// (treated as "no filter") so a bad query string never 500s the grid.
export function parseFilters(sp: SP): AuctionFilters {
  const gradeRaw = firstStr(sp.grade);
  const grades = gradeRaw
    ? gradeRaw.split(",").map((g) => g.trim().toUpperCase()).filter((g) => VALID_GRADES.includes(g))
    : undefined;
  const region = firstStr(sp.region);
  const sort = firstStr(sp.sort);
  const minD = posIntDollars(sp.min);
  const maxD = posIntDollars(sp.max);
  return {
    q: firstStr(sp.q),
    grades: grades && grades.length ? grades : undefined,
    minPrice: minD !== undefined ? minD * 100 : undefined,
    maxPrice: maxD !== undefined ? maxD * 100 : undefined,
    region: region && REGIONS.includes(region) ? region : undefined,
    sort: sort && VALID_SORTS.includes(sort) ? sort : undefined,
  };
}

// Search live auctions server-side, then re-fetch with vehicle/seller joins.
// The RPC returns the correct sort order; PostgREST `.in(...)` does NOT preserve
// order, so we re-sort the joined rows to match the RPC's id order.
export async function searchLiveAuctions(sb: SupabaseClient, filters: AuctionFilters): Promise<any[]> {
  const { data: ordered, error } = await sb.rpc("search_live_auctions", {
    p_q: filters.q ?? null,
    p_grades: filters.grades && filters.grades.length ? filters.grades : null,
    p_min_price: filters.minPrice ?? null,
    p_max_price: filters.maxPrice ?? null,
    p_region: filters.region ?? null,
    p_sort: filters.sort ?? null,
  });
  if (error || !ordered) return [];
  const ids = (ordered as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  const { data: joined } = await sb.from("auctions").select(AUCTION_WITH_JOINS).in("id", ids);
  const byId = new Map((joined ?? []).map((r: { id: string }) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Auction ids the dealer watches (for rendering filled/empty hearts).
export async function getWatchedAuctionIds(sb: SupabaseClient, dealerId: string): Promise<string[]> {
  const { data } = await sb.from("watchlist").select("auction_id").eq("dealer_id", dealerId);
  return (data ?? []).map((r: { auction_id: string }) => r.auction_id);
}

// The dealer's watched auctions joined to vehicle, newest watch first.
export async function getMyWatching(sb: SupabaseClient, dealerId: string): Promise<any[]> {
  const { data } = await sb
    .from("watchlist")
    .select("created_at, auction:auctions(*, vehicle:vehicles(*))")
    .eq("dealer_id", dealerId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r: { auction: unknown }) => r.auction).filter(Boolean);
}
