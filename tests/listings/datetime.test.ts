import { describe, it, expect } from "vitest";
import { utcToLocalInput } from "../../src/lib/datetime";

describe("utcToLocalInput", () => {
  it("round-trips a UTC instant through a datetime-local field (tz-independent)", () => {
    const utc = "2026-06-27T05:30:00.000Z";
    const local = utcToLocalInput(utc);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // datetime-local values are parsed as LOCAL time by `new Date()`; the local
    // wall-clock we produced must map back to the same instant (to the minute).
    expect(new Date(local).getTime()).toBe(Date.parse("2026-06-27T05:30:00Z"));
  });

  it("returns empty for missing or invalid input", () => {
    expect(utcToLocalInput("")).toBe("");
    expect(utcToLocalInput(null)).toBe("");
    expect(utcToLocalInput("not-a-date")).toBe("");
  });
});
