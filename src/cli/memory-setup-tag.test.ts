import { describe, it, expect } from "vitest";
import { resolveMemorySetupTag } from "./memory.js";

describe("resolveMemorySetupTag", () => {
  it("defaults to the persisted release.pin when no --tag is given (pinned fleet)", () => {
    expect(resolveMemorySetupTag({ releasePin: "v0.17.5" })).toEqual({
      tag: "v0.17.5",
      reason: "pin",
    });
    // Bare pin normalizes to canonical vX.Y.Z, same as the update path.
    expect(resolveMemorySetupTag({ releasePin: "0.17.5" })).toEqual({
      tag: "v0.17.5",
      reason: "pin",
    });
  });

  it("floats to :latest when there is no pin", () => {
    expect(resolveMemorySetupTag({})).toEqual({ tag: undefined, reason: "latest" });
    expect(resolveMemorySetupTag({ releasePin: "" })).toEqual({
      tag: undefined,
      reason: "latest",
    });
    // A non-normalizable pin (sha / garbage) can't be pinned → floats.
    expect(resolveMemorySetupTag({ releasePin: "sha-deadbeef" })).toEqual({
      tag: undefined,
      reason: "latest",
    });
  });

  it("lets an explicit --tag win over the persisted pin (normalized to vX.Y.Z)", () => {
    expect(resolveMemorySetupTag({ explicitTag: "v0.18.0", releasePin: "v0.17.5" })).toEqual({
      tag: "v0.18.0",
      reason: "explicit",
    });
    // A bare explicit tag is normalized to the canonical published form, so
    // the tag we print is EXACTLY the tag hindsightImageRef will run.
    expect(resolveMemorySetupTag({ explicitTag: "0.18.0", releasePin: "v0.17.5" })).toEqual({
      tag: "v0.18.0",
      reason: "explicit",
    });
  });

  it("rejects an explicit non-normalizable tag as invalid (must fail loudly, never float)", () => {
    // Regression for the #3088 review finding: hindsightImageRef floats
    // anything it can't normalize to :latest, so passing sha-deadbeef
    // through as "explicit" would print one tag and run another — a silent
    // un-pin. The resolver must flag it so the CLI can exit non-zero.
    expect(resolveMemorySetupTag({ explicitTag: "sha-deadbeef", releasePin: "v0.17.5" })).toEqual({
      tag: "sha-deadbeef",
      reason: "invalid",
    });
    expect(resolveMemorySetupTag({ explicitTag: "garbage" })).toEqual({
      tag: "garbage",
      reason: "invalid",
    });
    // The invalid explicit tag does NOT fall back to the pin or to :latest.
    expect(resolveMemorySetupTag({ explicitTag: "v0.18", releasePin: "v0.17.5" }).reason).toBe(
      "invalid",
    );
  });

  it("force-floats when --tag latest is passed explicitly, even on a pinned fleet", () => {
    expect(resolveMemorySetupTag({ explicitTag: "latest", releasePin: "v0.17.5" })).toEqual({
      tag: undefined,
      reason: "explicit-latest",
    });
    expect(resolveMemorySetupTag({ explicitTag: "LATEST", releasePin: "v0.17.5" })).toEqual({
      tag: undefined,
      reason: "explicit-latest",
    });
  });
});
