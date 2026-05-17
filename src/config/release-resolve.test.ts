import { describe, it, expect } from "vitest";
import { resolveImageTag, resolveRelease } from "./release-resolve.js";

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
