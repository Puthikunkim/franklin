import { describe, it, expect, beforeEach } from "vitest";
import { admin, anon } from "./helpers/db";

const D1 = "11111111-1111-1111-1111-111111111111";
const ANCHOR = "a0000000-0000-0000-0000-000000000a01";

async function clearWatches() {
  await admin.from("watchlist").delete().not("dealer_id", "is", null);
}
async function watchCount(dealer: string, auction: string) {
  const { data } = await admin.from("watchlist").select("dealer_id")
    .eq("dealer_id", dealer).eq("auction_id", auction);
  return (data ?? []).length;
}

describe("set_watch", () => {
  beforeEach(clearWatches);

  it("inserts a watch and returns true", async () => {
    const { data, error } = await admin.rpc("set_watch",
      { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(await watchCount(D1, ANCHOR)).toBe(1);
  });

  it("double-watch is idempotent (on conflict do nothing)", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    expect(await watchCount(D1, ANCHOR)).toBe(1);
  });

  it("unwatch deletes the row and returns false", async () => {
    await admin.rpc("set_watch", { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    const { data } = await admin.rpc("set_watch",
      { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: false });
    expect(data).toBe(false);
    expect(await watchCount(D1, ANCHOR)).toBe(0);
  });

  it("forbids the anon (browser) role from calling the RPC", async () => {
    const { error } = await anon.rpc("set_watch",
      { p_dealer_id: D1, p_auction_id: ANCHOR, p_watched: true });
    expect(error).not.toBeNull();
  });
});
