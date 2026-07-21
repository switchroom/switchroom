/**
 * ghost-skills incident — the hostd image must carry every package-relative
 * asset tree the apply AND update paths resolve via
 * `resolve(import.meta.dirname, "../../<asset>")`. profiles/ + vendor/ were
 * already guarded (the klanker incident); skills/ was NOT, so a hostd image
 * built without the shipped skills/ payload passed the preflight, then
 * `switchroom update`'s sync-bundled-skills step silently skipped (its
 * `!existsSync(source)` guard) and the builtin default skills never reached
 * the host pool. This test pins skills/ into the required-asset set so a
 * future hostd image that drops it is refused up front instead of stranding
 * the fleet mid-roll.
 *
 * We call the private `missingApplyAssets()` against a temp `applyAssetsRoot`
 * so the assertion is about the REAL required-asset list, not a stub.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { HostdServer } = await import("./server.js");
import type { ServerOptions } from "./server.js";

function serverWithRoot(root: string) {
  return new HostdServer({
    applyAssetsRoot: root,
  } as unknown as ServerOptions) as unknown as {
    missingApplyAssets: () => string[];
  };
}

/** Build a root that has every required asset EXCEPT the ones named. */
function makeRoot(omit: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "hostd-assets-"));
  const all: Array<[string, string[]]> = [
    ["profiles", ["profiles"]],
    ["profiles/default", ["profiles", "default"]],
    ["vendor/hindsight-memory", ["vendor", "hindsight-memory"]],
    ["skills", ["skills"]],
  ];
  for (const [name, parts] of all) {
    if (omit.includes(name)) continue;
    mkdirSync(join(root, ...parts), { recursive: true });
  }
  return root;
}

describe("missingApplyAssets — hostd image asset preflight", () => {
  it("passes when profiles, vendor, AND skills are all present", () => {
    const root = makeRoot();
    try {
      expect(serverWithRoot(root).missingApplyAssets()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a missing skills/ payload (the ghost-skills regression)", () => {
    const root = makeRoot(["skills"]);
    try {
      const missing = serverWithRoot(root).missingApplyAssets();
      expect(missing).toContain(join(root, "skills"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still flags a missing profiles/ payload (the klanker regression)", () => {
    const root = makeRoot(["profiles", "profiles/default"]);
    try {
      const missing = serverWithRoot(root).missingApplyAssets();
      expect(missing).toContain(join(root, "profiles"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
