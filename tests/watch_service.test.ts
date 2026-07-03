import { describe, it, expect, beforeEach } from "vitest";
import { admin } from "./helpers/db";
import { setWatch } from "../src/lib/watch/service";

const D1 = "11111111-1111-1111-1111-111111111111";
const ANCHOR = "a0000000-0000-0000-0000-000000000a01";

async function clearWatches() {
  await admin.from("watchlist").delete().not("dealer_id", "is", null);
}
async function watched(dealer: string, auction: string) {
  const { data } = await admin.from("watchlist").select("dealer_id")
    .eq("dealer_id", dealer).eq("auction_id", auction);
  return (data ?? []).length === 1;
}

describe("setWatch service", () => {
  beforeEach(clearWatches);

  it("watches and unwatches via the service-role client", async () => {
    expect(await setWatch(D1, ANCHOR, true)).toEqual({ ok: true, watched: true });
    expect(await watched(D1, ANCHOR)).toBe(true);
    expect(await setWatch(D1, ANCHOR, false)).toEqual({ ok: true, watched: false });
    expect(await watched(D1, ANCHOR)).toBe(false);
  });

  it("watching twice is idempotent", async () => {
    await setWatch(D1, ANCHOR, true);
    await setWatch(D1, ANCHOR, true);
    expect(await watched(D1, ANCHOR)).toBe(true);
  });
});
