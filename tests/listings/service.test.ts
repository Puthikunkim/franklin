import { describe, it, expect, afterEach } from "vitest";
import { deleteAuctions } from "../helpers/db";
import { createDraft, publishListing } from "../../src/lib/listings/service";
import { ListingInput } from "../../src/lib/listings/validation";

const SELLER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

// Own-fixture cleanup: track every auction this file creates and delete it in afterEach. The
// "publishes a valid draft" test flips a draft to 'live', which the old beforeEach(cleanupDrafts)
// — drafts only — left behind, leaking a live 'Toyota Hilux' into the shared DB per run.
const created: string[] = [];

function input(o: Partial<ListingInput> = {}): ListingInput {
  return {
    make: "Toyota", model: "Hilux", year: 2021, variant: "SR5", odometerKm: 40000,
    grade: "A", color: "White", mechanicalNotes: "", appraisalNotes: "",
    photoUrls: ["https://img/1.jpg"], startingPrice: 1000000, reservePrice: 1200000,
    buyNowPrice: 1500000, endTime: new Date(Date.now() + 2 * 86400000).toISOString(), ...o,
  };
}

describe("listing service", () => {
  afterEach(async () => { await deleteAuctions(created); created.length = 0; });

  it("rejects invalid input before hitting the DB", async () => {
    const r = await createDraft(SELLER, input({ make: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.make).toBeDefined();
  });

  it("creates a draft and returns its id", async () => {
    const r = await createDraft(SELLER, input());
    expect(r.ok).toBe(true);
    if (r.ok) {
      created.push(r.auctionId);
      expect(r.auctionId).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it("publishes a valid draft", async () => {
    const c = await createDraft(SELLER, input());
    if (!c.ok) throw new Error("setup failed");
    created.push(c.auctionId);
    const r = await publishListing(SELLER, c.auctionId);
    expect(r).toEqual({ ok: true });
  });

  it("reports a non-owner publish as a reason", async () => {
    const c = await createDraft(SELLER, input());
    if (!c.ok) throw new Error("setup failed");
    created.push(c.auctionId);
    const r = await publishListing(OTHER, c.auctionId);
    expect(r).toEqual({ ok: false, reason: "not_owner" });
  });
});
