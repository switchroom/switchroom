import { describe, it, expect } from "vitest";
import { resolveImageTag, resolveRelease, compareReleaseTags } from "./release-resolve.js";

describe("resolveImageTag", () => {
  it("defaults to 'latest' when undefined", () => {
    expect(resolveImageTag(undefined)).toBe("latest");
  });
  it("returns channel when only channel set", () => {
    expect(resolveImageTag({ channel: "dev" })).toBe("dev");
    expect(resolveImageTag({ channel: "rc" })).toBe("rc");
    expect(resolveImageTag({ channel: "latest" })).toBe("latest");
  });
  it("returns pin verbatim for sha pins", () => {
    expect(resolveImageTag({ pin: "sha-abc1234" })).toBe("sha-abc1234");
  });
  it("returns pin verbatim for semver pins", () => {
    expect(resolveImageTag({ pin: "v0.11.1" })).toBe("v0.11.1");
  });
  it("pin wins over channel (should not occur but defensive)", () => {
    expect(resolveImageTag({ channel: "dev", pin: "v1.0.0" })).toBe("v1.0.0");
  });
});

describe("resolveRelease", () => {
  it("returns undefined when nothing supplied", () => {
    expect(resolveRelease({})).toBeUndefined();
  });
  it("override beats per-agent beats root", () => {
    const ov = { channel: "dev" as const };
    const pa = { pin: "v0.1.0" };
    const rt = { channel: "latest" as const };
    expect(resolveRelease({ override: ov, perAgent: pa, root: rt })).toBe(ov);
    expect(resolveRelease({ perAgent: pa, root: rt })).toBe(pa);
    expect(resolveRelease({ root: rt })).toBe(rt);
  });
});

describe("compareReleaseTags", () => {
  it("orders semver tags", () => {
    expect(compareReleaseTags("v0.15.32", "v0.15.34")).toBeLessThan(0); // older
    expect(compareReleaseTags("v0.15.34", "v0.15.32")).toBeGreaterThan(0); // newer
    expect(compareReleaseTags("v0.15.33", "v0.15.33")).toBe(0); // same
  });
  it("compares major/minor/patch in order", () => {
    expect(compareReleaseTags("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
    expect(compareReleaseTags("v0.16.0", "v0.15.99")).toBeGreaterThan(0);
    expect(compareReleaseTags("v0.15.9", "v0.15.10")).toBeLessThan(0); // numeric, not lexical
  });
  it("returns null when either side is not a vX.Y.Z tag (unorderable)", () => {
    expect(compareReleaseTags("latest", "v0.15.34")).toBeNull();
    expect(compareReleaseTags("v0.15.34", "dev")).toBeNull();
    expect(compareReleaseTags("sha-abc1234", "v0.15.34")).toBeNull();
    expect(compareReleaseTags("v0.15.34", null)).toBeNull();
    expect(compareReleaseTags(undefined, "v0.15.34")).toBeNull();
    expect(compareReleaseTags("v0.15", "v0.15.0")).toBeNull(); // not 3-part
  });
});
