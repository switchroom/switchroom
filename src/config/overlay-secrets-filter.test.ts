import { describe, it, expect } from "vitest";
import { filterOverlaySecrets } from "./overlay-secrets-filter.js";

describe("filterOverlaySecrets", () => {
  it("passes through operator-authored docs even with secrets", () => {
    const r = filterOverlaySecrets(
      { schedule: [{ cron: "0 * * * *", prompt: "hi", secrets: ["foo/bar"] }] },
      "operator",
    );
    expect(r).toBeNull();
  });

  it("rejects overlay docs with non-empty secrets", () => {
    const r = filterOverlaySecrets(
      { schedule: [{ cron: "0 * * * *", prompt: "hi", secrets: ["foo/bar"] }] },
      "overlay",
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("E_OVERLAY_SECRETS_REQUIRES_APPROVAL");
    expect(r!.entry_index).toBe(0);
    expect(r!.requested_secrets).toEqual(["foo/bar"]);
  });

  it("passes overlay docs with empty secrets array", () => {
    const r = filterOverlaySecrets(
      { schedule: [{ cron: "0 * * * *", prompt: "hi", secrets: [] }] },
      "overlay",
    );
    expect(r).toBeNull();
  });

  it("passes overlay docs with no schedule entries at all", () => {
    const r = filterOverlaySecrets({}, "overlay");
    expect(r).toBeNull();
  });

  it("flags the offending entry's index", () => {
    const r = filterOverlaySecrets(
      {
        schedule: [
          { cron: "0 * * * *", prompt: "ok", secrets: [] },
          { cron: "5 * * * *", prompt: "bad", secrets: ["k"] },
        ],
      },
      "overlay",
    );
    expect(r).not.toBeNull();
    expect(r!.entry_index).toBe(1);
  });
});
