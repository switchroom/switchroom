/**
 * #4269 — hostdTemplateRegenVerdict: the Done card's definite
 * "hostd template regen REQUIRED / not needed" decision.
 *
 * Tags are derived RELATIVE to HOSTD_TEMPLATE_LAST_CHANGED so these tests
 * stay true when the constant is legitimately bumped by a future template
 * change (the check-hostd-template-guard lint forces that bump).
 *
 * Historical ground truth this logic was verified against: the hostd
 * template last changed in v0.19.43 (commit 9919c75b, the dockerSocketPath
 * bind), so the v0.19.48 → v0.20.0 roll that motivated #4269 did NOT need a
 * regen — the card at the time hedged anyway. With the constant at
 * v0.19.43, this module answers that exact case "not-needed".
 */

import { describe, it, expect } from "vitest";
import {
  HOSTD_TEMPLATE_LAST_CHANGED,
  hostdTemplateRegenVerdict,
} from "./hostd-template-version.js";

const LC = HOSTD_TEMPLATE_LAST_CHANGED;
const major = Number(LC.slice(1).split(".")[0]);
// Strictly before any plausible constant value.
const BEFORE_A = "v0.0.1";
const BEFORE_B = "v0.0.2";
// Strictly after the constant, whatever it is.
const AFTER_A = `v${major + 1}.0.0`;
const AFTER_B = `v${major + 1}.0.1`;

describe("hostdTemplateRegenVerdict (#4269)", () => {
  it("constant is a clean release tag", () => {
    expect(LC).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("REQUIRED when the roll lands exactly on the template-change release", () => {
    expect(hostdTemplateRegenVerdict(LC, BEFORE_A)).toBe("required");
  });

  it("REQUIRED when the roll skips over the template-change release", () => {
    expect(hostdTemplateRegenVerdict(AFTER_A, BEFORE_A)).toBe("required");
  });

  it("REQUIRED for a rollback that crosses the change backwards", () => {
    expect(hostdTemplateRegenVerdict(BEFORE_A, AFTER_A)).toBe("required");
  });

  it("not-needed when both endpoints are on/after the change (the v0.19.48 → v0.20.0 case)", () => {
    // from === the change release ⇒ the on-disk template already matches.
    expect(hostdTemplateRegenVerdict(AFTER_A, LC)).toBe("not-needed");
    expect(hostdTemplateRegenVerdict(AFTER_B, AFTER_A)).toBe("not-needed");
  });

  it("not-needed when both endpoints predate the change", () => {
    expect(hostdTemplateRegenVerdict(BEFORE_B, BEFORE_A)).toBe("not-needed");
  });

  it("unknown when the from version is missing (no definite claim)", () => {
    expect(hostdTemplateRegenVerdict(AFTER_A)).toBe("unknown");
    expect(hostdTemplateRegenVerdict(AFTER_A, null)).toBe("unknown");
  });

  it("unknown for non-semver endpoints (channels/shas never get a definite claim)", () => {
    expect(hostdTemplateRegenVerdict("latest", BEFORE_A)).toBe("unknown");
    expect(hostdTemplateRegenVerdict(AFTER_A, "deadbeef")).toBe("unknown");
  });
});
