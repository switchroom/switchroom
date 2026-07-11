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

  it("lets an explicit --tag win over the persisted pin", () => {
    expect(resolveMemorySetupTag({ explicitTag: "v0.18.0", releasePin: "v0.17.5" })).toEqual({
      tag: "v0.18.0",
      reason: "explicit",
    });
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
