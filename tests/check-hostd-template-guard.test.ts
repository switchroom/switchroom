/**
 * Tests for the hostd-template constant guard
 * (`scripts/check-hostd-template-guard.ts`, #4269).
 *
 * The guard's job: the rollout Done card claims DEFINITELY whether a release
 * needs a host-side `switchroom hostd install` template regen, by comparing
 * the roll window against HOSTD_TEMPLATE_LAST_CHANGED — so the constant MUST
 * move whenever `renderHostdComposeFile`'s shape moves. We assert OUTCOMES of
 * the pure decision function (evaluateHostdTemplateGuard), plus:
 *   - the real repo passes at HEAD (the checked-in baseline is consistent
 *     with the actual template and constant), and
 *   - fail-on-bug: a template shape change WITHOUT a constant bump fails,
 *     at both trip wires (stale baseline hash; re-hashed baseline with an
 *     unbumped constant vs origin/main).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateHostdTemplateGuard,
  renderCanonicalTemplate,
  normalizeTemplate,
  templateHash,
  BASELINE_PATH,
  type HostdTemplateBaseline,
} from "../scripts/check-hostd-template-guard.js";
import { HOSTD_TEMPLATE_LAST_CHANGED } from "../src/config/hostd-template-version.js";

const REPO = resolve(import.meta.dirname, "..");

function realBaseline(): HostdTemplateBaseline {
  return JSON.parse(
    readFileSync(resolve(REPO, BASELINE_PATH), "utf-8"),
  ) as HostdTemplateBaseline;
}

describe("check-hostd-template-guard (#4269)", () => {
  it("the real repo passes at HEAD (baseline consistent with template + constant)", () => {
    const failures = evaluateHostdTemplateGuard({
      actualHash: templateHash(renderCanonicalTemplate()),
      constant: HOSTD_TEMPLATE_LAST_CHANGED,
      baseline: realBaseline(),
      mainBaseline: realBaseline(),
    });
    expect(failures).toEqual([]);
  });

  it("FAILS when the template shape changes and the baseline was not touched", () => {
    // Simulate a real mounts change: append a volume line to the rendered
    // template — the hash the guard computes at HEAD no longer matches the
    // checked-in baseline.
    const mutated =
      renderCanonicalTemplate() + "\n      - /etc/new-mount:/etc/new-mount:ro";
    const failures = evaluateHostdTemplateGuard({
      actualHash: templateHash(mutated),
      constant: HOSTD_TEMPLATE_LAST_CHANGED,
      baseline: realBaseline(),
      mainBaseline: realBaseline(),
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toContain("bump HOSTD_TEMPLATE_LAST_CHANGED");
  });

  it("FAILS when the baseline hash is re-recorded but the constant is NOT bumped (vs origin/main)", () => {
    // The lazy 'fix': update templateSha256 so the hash rule passes, leave
    // lastChanged (and the constant) alone. The never-silent rule against
    // the origin/main baseline catches exactly this.
    const main = realBaseline();
    const mutatedHash = templateHash(renderCanonicalTemplate() + "\nX: 1");
    const failures = evaluateHostdTemplateGuard({
      actualHash: mutatedHash,
      constant: HOSTD_TEMPLATE_LAST_CHANGED,
      baseline: { templateSha256: mutatedHash, lastChanged: main.lastChanged },
      mainBaseline: main,
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toContain("did not move FORWARD");
  });

  it("PASSES a legitimate template change: new hash + constant bumped forward", () => {
    const main = realBaseline();
    const mutatedHash = templateHash(renderCanonicalTemplate() + "\nX: 1");
    const bumped = "v99.0.0";
    const failures = evaluateHostdTemplateGuard({
      actualHash: mutatedHash,
      constant: bumped,
      baseline: { templateSha256: mutatedHash, lastChanged: bumped },
      mainBaseline: main,
    });
    expect(failures).toEqual([]);
  });

  it("FAILS when the constant and the baseline lastChanged drift apart", () => {
    const failures = evaluateHostdTemplateGuard({
      actualHash: templateHash(renderCanonicalTemplate()),
      constant: "v99.0.0",
      baseline: realBaseline(),
      mainBaseline: null,
    });
    expect(failures.join("\n")).toContain("lockstep");
  });

  it("FAILS on a constant that is not a clean release tag", () => {
    const b = realBaseline();
    const failures = evaluateHostdTemplateGuard({
      actualHash: b.templateSha256,
      constant: "latest",
      baseline: { ...b, lastChanged: "latest" },
      mainBaseline: null,
    });
    expect(failures.join("\n")).toContain("not a clean release tag");
  });

  it("comment/wording edits inside the template do NOT move the hash (shape-only normalization)", () => {
    const rendered = renderCanonicalTemplate();
    const withExtraComments = rendered
      .split("\n")
      .flatMap((l) => (l.trim().startsWith("#") ? [] : [l]))
      .join("\n");
    // Same normalized form whether comments are present, absent, or reworded.
    expect(normalizeTemplate(withExtraComments)).toBe(normalizeTemplate(rendered));
    expect(templateHash(rendered + "\n# a new comment line")).toBe(
      templateHash(rendered),
    );
  });

  it("origin/main baseline unreadable ⇒ the lockstep + hash rules still bind", () => {
    const failures = evaluateHostdTemplateGuard({
      actualHash: "deadbeef",
      constant: HOSTD_TEMPLATE_LAST_CHANGED,
      baseline: realBaseline(),
      mainBaseline: null,
    });
    expect(failures.length).toBeGreaterThan(0);
  });
});
