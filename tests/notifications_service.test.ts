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
