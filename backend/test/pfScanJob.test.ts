import { describe, it, expect } from "vitest";
import { buildPfScanJobId } from "../src/services/pfScanJob";

describe("buildPfScanJobId", () => {
  const base = {
    seller: "batudeals",
    scanType: "sold" as const,
    daysBack: 30,
    forceRefresh: false,
  };

  it("never contains colons, spaces, or slashes", () => {
    const id = buildPfScanJobId(
      { ...base, seller: "Bat u:Deals/UK", scanType: "sold", forceRefresh: true },
      "default"
    );
    expect(id).not.toMatch(/[:/\s]/);
    expect(id).toBe("sold-default-bat-u-deals-uk-30-fresh");
  });

  it("dedupes identical inputs", () => {
    const a = buildPfScanJobId(base, "default");
    const b = buildPfScanJobId(base, "default");
    expect(a).toBe(b);
    expect(a).toBe("sold-default-batudeals-30-cache");
  });

  it("differs when seller or refresh changes", () => {
    const a = buildPfScanJobId(base, "default");
    const b = buildPfScanJobId({ ...base, seller: "other" }, "default");
    const c = buildPfScanJobId({ ...base, forceRefresh: true }, "default");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
