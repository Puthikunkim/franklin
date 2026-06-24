import { describe, it, expect } from "vitest";
import { validateListing, ListingInput } from "../../src/lib/listings/validation";

const NOW = Date.parse("2026-06-25T00:00:00Z");
function valid(o: Partial<ListingInput> = {}): ListingInput {
  return {
    make: "Toyota", model: "Hilux", year: 2021, variant: "SR5", odometerKm: 40000,
    grade: "A", color: "White", mechanicalNotes: "", appraisalNotes: "",
    photoUrls: ["https://img/1.jpg"], startingPrice: 1000000, reservePrice: 1200000,
    buyNowPrice: 1500000, endTime: new Date(NOW + 2 * 86400000).toISOString(), ...o,
  };
}

describe("validateListing", () => {
  it("accepts a well-formed listing", () => {
    expect(validateListing(valid(), NOW)).toEqual({});
  });
  it("requires make and model", () => {
    expect(validateListing(valid({ make: "  " }), NOW).make).toBeDefined();
    expect(validateListing(valid({ model: "" }), NOW).model).toBeDefined();
  });
  it("bounds the year", () => {
    expect(validateListing(valid({ year: 1979 }), NOW).year).toBeDefined();
    expect(validateListing(valid({ year: 2028 }), NOW).year).toBeDefined();
  });
  it("requires reserve >= starting and buy-now > reserve", () => {
    expect(validateListing(valid({ startingPrice: 1000000, reservePrice: 900000 }), NOW).reservePrice).toBeDefined();
    expect(validateListing(valid({ reservePrice: 1200000, buyNowPrice: 1200000 }), NOW).buyNowPrice).toBeDefined();
  });
  it("requires a future end_time within 30 days", () => {
    expect(validateListing(valid({ endTime: new Date(NOW - 1000).toISOString() }), NOW).endTime).toBeDefined();
    expect(validateListing(valid({ endTime: new Date(NOW + 31 * 86400000).toISOString() }), NOW).endTime).toBeDefined();
  });
  it("requires 1–12 photos", () => {
    expect(validateListing(valid({ photoUrls: [] }), NOW).photoUrls).toBeDefined();
    expect(validateListing(valid({ photoUrls: Array(13).fill("x") }), NOW).photoUrls).toBeDefined();
  });
});
