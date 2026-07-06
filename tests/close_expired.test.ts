import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { admin, anon, resetDb, createLiveAuction, deleteAuctions } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333"; // fixture seller (never a bidder)

const created: string[] = [];
async function makeLive(): Promise<string> {
  const id = await createLiveAuction(D3);
  created.push(id);
  return id;
}
async function bid(auction: string, dealer: string, max: number) {
  const { error } = await admin.rpc("place_bid", { p_auction_id: auction, p_dealer_id: dealer, p_max_amount: max });
  if (error) throw error;
}
async function expire(auction: string) {
  const { error } = await admin.rpc("test_set_end_in_seconds", { p_auction_id: auction, p_seconds: -1 });
  if (error) throw error;
}
async function sweep(): Promise<number> {
  const { data, error } = await admin.rpc("close_expired_auctions");
  if (error) throw error;
  return data as number;
}
async function statusOf(id: string): Promise<string> {
  const { data } = await admin.from("auctions").select("status").eq("id", id).single();
  return data!.status as string;
}
async function notifs(recipient: string, type: string) {
  const { data } = await admin.from("notifications").select("id")
    .eq("recipient_dealer_id", recipient).eq("type", type);
  return data ?? [];
}

describe("close_expired_auctions", () => {
  beforeEach(resetDb); // future-dates every seeded auction, so only our expired fixtures get swept
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("closes an expired reserve-met auction as sold with settlement + won/sold notifications", async () => {
    const id = await makeLive();
    await bid(id, D1, 1300000);   // D1 leads at the 1,000,000 starting price
    await bid(id, D2, 1250000);   // below D1's proxy → D1 holds, price rises to 1,275,000 (>= reserve), no outbid row
    await expire(id);
    expect(await sweep()).toBe(1);
    expect(await statusOf(id)).toBe("sold");
    const { data: s } = await admin.from("settlements").select("sale_price").eq("auction_id", id).single();
    expect(s!.sale_price).toBe(1275000);
    expect((await notifs(D1, "won")).length).toBe(1);
    expect((await notifs(D3, "sold")).length).toBe(1);
  });

  it("closes an expired no-bid auction as passed with no settlement or notifications", async () => {
    const id = await makeLive();
    await expire(id);
    await sweep();
    expect(await statusOf(id)).toBe("passed");
    const { data: s } = await admin.from("settlements").select("id").eq("auction_id", id);
    expect(s!.length).toBe(0);
    expect((await notifs(D3, "sold")).length).toBe(0);
  });

  it("leaves a non-expired live auction untouched", async () => {
    const id = await makeLive(); // default end_time = now + 2 days
    await sweep();
    expect(await statusOf(id)).toBe("live");
  });

  it("closes multiple expired auctions in one call and returns the count", async () => {
    const a = await makeLive();
    const b = await makeLive();
    await expire(a); await expire(b);
    expect(await sweep()).toBe(2);
    expect(await statusOf(a)).not.toBe("live");
    expect(await statusOf(b)).not.toBe("live");
  });

  it("is idempotent — a second sweep closes nothing new", async () => {
    const id = await makeLive();
    await expire(id);
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await statusOf(id)).not.toBe("live");
  });

  it("is callable by the anon (browser) role", async () => {
    const { error } = await anon.rpc("close_expired_auctions");
    expect(error).toBeNull();
  });

  it("search_live_auctions excludes an expired-but-unswept live auction", async () => {
    const id = await makeLive();
    await expire(id); // still status='live', just past end_time; do NOT sweep
    const { data } = await admin.rpc("search_live_auctions", {
      p_q: null, p_grades: null, p_min_price: null, p_max_price: null, p_region: null, p_sort: null,
    });
    const ids = (data as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(id);
  });
});
