import { describe, expect, it } from "vitest";
import { majorMinor, versionsDiffer } from "@/lib/core/version";

describe("version checks", () => {
  it("reads major.minor", () => {
    expect(majorMinor("1.4.2")).toBe("1.4");
    expect(majorMinor("v0.1.0")).toBe("0.1");
    expect(majorMinor("0.0.0-abc1234")).toBe("0.0");
    expect(majorMinor("dev")).toBeNull();
  });

  it("warns only when two releases differ in major.minor", () => {
    expect(versionsDiffer("0.1.0", "0.1.3")).toBe(false);
    expect(versionsDiffer("0.1.0", "0.2.0")).toBe(true);
    expect(versionsDiffer("1.0.0", "2.0.0")).toBe(true);
    expect(versionsDiffer("0.0.0-abc1234", "0.2.0")).toBe(false);
    expect(versionsDiffer("0.2.0", "unknown")).toBe(false);
  });
});
