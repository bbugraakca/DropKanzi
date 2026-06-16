import { describe, it, expect } from "vitest";
import { parseNumericFilter, parseSortColumn } from "../src/services/sqlFilter";

describe("parseNumericFilter", () => {
  it("rejects non-numeric and tenant-like strings", () => {
    expect(parseNumericFilter("default")).toBeUndefined();
    expect(parseNumericFilter("")).toBeUndefined();
    expect(parseNumericFilter(null)).toBeUndefined();
    expect(parseNumericFilter(undefined)).toBeUndefined();
    expect(parseNumericFilter("NaN")).toBeUndefined();
    expect(parseNumericFilter(Number.NaN)).toBeUndefined();
  });

  it("accepts positive finite numbers", () => {
    expect(parseNumericFilter("12.5")).toBe(12.5);
    expect(parseNumericFilter(3)).toBe(3);
  });

  it("rejects zero and negatives when exclusiveMin", () => {
    expect(parseNumericFilter(0, { min: 0, exclusiveMin: true })).toBeUndefined();
    expect(parseNumericFilter(-1, { min: 0, exclusiveMin: true })).toBeUndefined();
  });
});

describe("parseSortColumn", () => {
  const allowed = ["profit", "margin", "match"] as const;

  it("returns fallback for unknown sort keys", () => {
    expect(parseSortColumn("default", allowed, "profit")).toBe("profit");
    expect(parseSortColumn("'; DROP TABLE--", allowed, "profit")).toBe("profit");
  });

  it("allows listed keys only", () => {
    expect(parseSortColumn("margin", allowed, "profit")).toBe("margin");
  });
});
