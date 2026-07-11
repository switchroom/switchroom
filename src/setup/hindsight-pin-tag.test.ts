import { describe, it, expect } from "vitest";
import {
  normalizeHindsightVersionTag,
  hindsightImageRef,
  HINDSIGHT_IMAGE,
  HINDSIGHT_IMAGE_REPO,
} from "./hindsight.js";

describe("normalizeHindsightVersionTag", () => {
  it("canonicalizes a v-prefixed vX.Y.Z to itself", () => {
    expect(normalizeHindsightVersionTag("v0.17.5")).toBe("v0.17.5");
    expect(normalizeHindsightVersionTag("v0.15.18")).toBe("v0.15.18");
  });

  it("canonicalizes a bare X.Y.Z to vX.Y.Z", () => {
    expect(normalizeHindsightVersionTag("0.17.5")).toBe("v0.17.5");
    expect(normalizeHindsightVersionTag("10.2.300")).toBe("v10.2.300");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeHindsightVersionTag("  v0.17.5  ")).toBe("v0.17.5");
    expect(normalizeHindsightVersionTag("\t0.17.5\n")).toBe("v0.17.5");
  });

  it("returns undefined for empty / undefined input", () => {
    expect(normalizeHindsightVersionTag(undefined)).toBeUndefined();
    expect(normalizeHindsightVersionTag("")).toBeUndefined();
    expect(normalizeHindsightVersionTag("   ")).toBeUndefined();
  });

  it("returns undefined for sha pins and other non-version strings", () => {
    expect(normalizeHindsightVersionTag("sha-deadbeef")).toBeUndefined();
    expect(normalizeHindsightVersionTag("latest")).toBeUndefined();
    expect(normalizeHindsightVersionTag("0.17")).toBeUndefined();
    expect(normalizeHindsightVersionTag("v0.17.5-rc1")).toBeUndefined();
    expect(normalizeHindsightVersionTag("garbage")).toBeUndefined();
  });
});

describe("hindsightImageRef (shares normalizeHindsightVersionTag)", () => {
  it("floats to :latest when no tag is given", () => {
    expect(hindsightImageRef()).toBe(HINDSIGHT_IMAGE);
    expect(hindsightImageRef("")).toBe(HINDSIGHT_IMAGE);
    expect(hindsightImageRef("   ")).toBe(HINDSIGHT_IMAGE);
  });

  it("pins a bare and a v-prefixed version to the same :vX.Y.Z ref", () => {
    expect(hindsightImageRef("0.17.5")).toBe(`${HINDSIGHT_IMAGE_REPO}:v0.17.5`);
    expect(hindsightImageRef("v0.17.5")).toBe(`${HINDSIGHT_IMAGE_REPO}:v0.17.5`);
  });

  it("floats a non-normalizable tag (sha / garbage) to :latest", () => {
    expect(hindsightImageRef("sha-deadbeef")).toBe(HINDSIGHT_IMAGE);
    expect(hindsightImageRef("garbage")).toBe(HINDSIGHT_IMAGE);
  });
});
