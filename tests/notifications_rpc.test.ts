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
