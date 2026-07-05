import { describe, it, expect, beforeEach } from "vitest";
import { admin, resetDb } from "./helpers/db";
import { buyNow } from "../src/lib/purchase/service";

const D1 = "11111111-1111-1111-1111-111111111111"; // buyer
const D3 = "33333333-3333-3333-3333-333333333333"; // seller of the CR-V
const CRV = "a0000000-0000-0000-0000-000000000a03";

describe("buyNow service", () => {
  beforeEach(resetDb);

  it("returns ok and marks the auction sold on a successful purchase", async () => {
    expect(await buyNow(D1, CRV)).toEqual({ ok: true });
    const { data: a } = await admin.from("auctions").select("status").eq("id", CRV).single();
    expect(a!.status).toBe("sold");
  });

  it("returns the reason when the seller tries to buy their own listing", async () => {
    expect(await buyNow(D3, CRV)).toEqual({ ok: false, reason: "is_seller" });
  });
});
