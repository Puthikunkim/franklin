import { describe, it, expect } from "vitest";
import { formatNZD, dollarsToCents } from "../src/lib/money";

describe("money", () => {
  it("formats cents as NZD dollars with thousands separators", () => {
    expect(formatNZD(820000)).toBe("$8,200");
    expect(formatNZD(0)).toBe("$0");
    expect(formatNZD(99900)).toBe("$999");
  });
  it("converts dollars to integer cents", () => {
    expect(dollarsToCents(8200)).toBe(820000);
    expect(dollarsToCents(7.5)).toBe(750);
  });
});
