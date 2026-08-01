/**
 * #4161 — `sync-bundled-skills` must not report SUCCESS when it could
 * not find the shipped `skills/` payload.
 *
 * Pre-fix the step resolved its source as
 * `resolve(import.meta.dirname, "../../skills")`, which inside a
 * `bun build --compile` binary (`import.meta.dirname === "/$bunfs/root"`)
 * is `/skills`. It wrote one stderr line and RETURNED — the step was
 * ticked green, the pool at `~/.switchroom/skills/_bundled/` went
 * un-refreshed for weeks, and `switchroom apply` then told the operator
 * to "re-run `switchroom update` to repair the pool", i.e. to re-run the
 * very step that was broken.
 *
 * These tests drive the REAL step body with an injected layout probe, so
 * they fail on the pre-fix behaviour (silent return, no throw, no
 * warning) rather than merely walking the code path.
 */

import { describe, it, expect } from "vitest";
import { planUpdate } from "./update.js";
import type { InstallProbe } from "./self-update.js";

/** The layout a published static binary actually sees: virtual bundle
 *  dir, real binary on disk, and no shipped payload anywhere. */
const SEA_LAYOUT_NO_PAYLOAD = {
  bundleDir: "/$bunfs/root",
  execPath: "/usr/local/bin/switchroom",
  env: {},
  exists: () => false,
};

const installProbe = (
  over: Partial<InstallProbe> = {},
): InstallProbe => ({
  bundleDir: "/$bunfs/root",
  execPath: "/usr/local/bin/switchroom",
  scriptPath: "/usr/local/bin/switchroom",
  inContainer: false,
  ...over,
});

function syncStep(opts: Parameters<typeof planUpdate>[0]) {
  return planUpdate({ composePath: "unused", ...opts }).find(
    (s) => s.name === "sync-bundled-skills",
  )!;
}

describe("sync-bundled-skills with no shipped skills/ payload", () => {
  it("FAILS the step on a published static binary (packaging defect)", () => {
    const step = syncStep({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      shippedSkillsProbe: SEA_LAYOUT_NO_PAYLOAD,
      installProbe: installProbe(),
    });
    // The bug: this used to return normally.
    expect(() => step.run()).toThrow(/sync-bundled-skills/);
    let message = "";
    try {
      step.run();
    } catch (err) {
      message = (err as Error).message;
    }
    // The error must name every path tried, so the operator can stage one.
    expect(message).toContain("/usr/local/share/switchroom/skills");
    expect(message).toContain("/usr/share/switchroom/skills");
    expect(message).toContain("static-binary");
  });

  it("FAILS the step inside a container image (payload is part of the image)", () => {
    const step = syncStep({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      shippedSkillsProbe: {
        bundleDir: "/opt/switchroom",
        execPath: "/usr/local/bin/bun",
        env: {},
        exists: () => false,
      },
      installProbe: installProbe({ inContainer: true }),
    });
    expect(() => step.run()).toThrow(/packaging defect/);
  });

  it("FAILS the step on an npm install", () => {
    const step = syncStep({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      shippedSkillsProbe: {
        bundleDir: "/usr/lib/node_modules/switchroom/dist/cli",
        execPath: "/usr/local/bin/node",
        env: {},
        exists: () => false,
      },
      installProbe: installProbe({
        bundleDir: "/usr/lib/node_modules/switchroom/dist/cli",
        scriptPath: "/usr/lib/node_modules/switchroom/dist/cli/switchroom.js",
      }),
    });
    expect(() => step.run()).toThrow(/packaging defect/);
  });

  it("does NOT fail a source checkout, but records a surfaced warning", () => {
    // A local dev layout without an adjacent skills/ is unusual, not a
    // shipping defect — failing hard there would be the regression the
    // fix must avoid. It still must not look like a clean run.
    const warningSink: string[] = [];
    const step = syncStep({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      shippedSkillsProbe: {
        bundleDir: "/home/dev/switchroom/dist/cli",
        execPath: "/usr/local/bin/bun",
        env: {},
        exists: () => false,
      },
      installProbe: installProbe({
        bundleDir: "/home/dev/switchroom/dist/cli",
        scriptPath: "/home/dev/switchroom/dist/cli/switchroom.js",
      }),
      warningSink,
    });
    expect(() => step.run()).not.toThrow();
    // The bug this guards: a lone stderr line inside a long log, with the
    // step ticked green and nothing in the summary.
    expect(warningSink).toHaveLength(1);
    expect(warningSink[0]).toMatch(/sync-bundled-skills SKIPPED/);
    expect(warningSink[0]).toContain("skills/_bundled");
  });

  it("still copies normally when the payload IS found (no regression)", () => {
    // Proves the loud path is gated on the MISSING case only: with a
    // resolvable payload the step runs its real body. The test seam
    // `syncBundledSkillsFn` stands in for the filesystem copy so this
    // never writes to the operator's real ~/.switchroom.
    let copied = 0;
    const step = syncStep({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      syncBundledSkillsFn: () => {
        copied += 1;
      },
      shippedSkillsProbe: SEA_LAYOUT_NO_PAYLOAD,
      installProbe: installProbe(),
    });
    expect(() => step.run()).not.toThrow();
    expect(copied).toBe(1);
  });
});
