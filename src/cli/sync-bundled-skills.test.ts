/**
 * Unit tests for the manifest-owned additive bundled-skill sync (footgun B).
 *
 * The load-bearing property under test: `switchroom update` must NEVER wipe
 * a hand-added pool skill (the historical `rm -rf` + `cp` bug). Every test
 * asserts an OUTCOME on the pool contents / manifest, not just that a code
 * path ran.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  syncBundledSkills,
  readBundledSkillManifest,
  BUNDLED_SKILL_MANIFEST_NAME,
  type BundledSkillManifest,
} from "./sync-bundled-skills.js";

let root: string;
let source: string;
let dest: string;

function makeSkill(dir: string, name: string, body = "x"): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `# ${name}\n${body}\n`, "utf8");
}

function readManifest(poolDir: string): BundledSkillManifest {
  const r = readBundledSkillManifest(poolDir);
  if (!("manifest" in r)) throw new Error("expected a valid manifest");
  return r.manifest;
}

function skillBody(poolDir: string, name: string): string {
  return readFileSync(join(poolDir, name, "SKILL.md"), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sr-sync-"));
  source = join(root, "src-skills");
  dest = join(root, "pool");
  mkdirSync(source, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("syncBundledSkills", () => {
  it("first run (no manifest): copies shipped skills, deletes nothing, writes a manifest", () => {
    makeSkill(source, "alpha");
    makeSkill(source, "beta");
    const r = syncBundledSkills({ source, dest, version: "1.2.3" });

    expect(r.firstRun).toBe(true);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(dest, "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "beta", "SKILL.md"))).toBe(true);

    const m = readManifest(dest);
    expect(m.skills.sort()).toEqual(["alpha", "beta"]);
    expect(m.version).toBe("1.2.3");
  });

  it("adopts a pre-manifest pool dir on first run and never deletes it (bootstrap, Open-Risk #3)", () => {
    // Pool already has dirs (added before manifests existed), including one
    // switchroom no longer/never ships.
    makeSkill(dest, "legacy-adopted");
    makeSkill(dest, "alpha", "OLD");
    makeSkill(source, "alpha", "NEW");

    const r = syncBundledSkills({ source, dest, version: "1" });
    expect(r.firstRun).toBe(true);
    expect(r.removed).toEqual([]);
    // The shipped one is refreshed...
    expect(skillBody(dest, "alpha")).toContain("NEW");
    // ...and the unshipped pre-existing dir survives.
    expect(existsSync(join(dest, "legacy-adopted", "SKILL.md"))).toBe(true);
    expect(r.preserved).toContain("legacy-adopted");
  });

  it("HAND-ADDED skill survives a subsequent update (the footgun-B guarantee)", () => {
    // Round 1: ship alpha.
    makeSkill(source, "alpha");
    syncBundledSkills({ source, dest, version: "1" });
    // Operator hand-adds a skill into the pool.
    makeSkill(dest, "operator-custom", "PRECIOUS");

    // Round 2: a new update ships alpha + beta (NOT operator-custom).
    makeSkill(source, "beta");
    const r = syncBundledSkills({ source, dest, version: "2" });

    // The hand-added skill is neither removed nor recorded as owned.
    expect(r.removed).not.toContain("operator-custom");
    expect(existsSync(join(dest, "operator-custom", "SKILL.md"))).toBe(true);
    expect(skillBody(dest, "operator-custom")).toContain("PRECIOUS");
    expect(r.preserved).toContain("operator-custom");
    // Manifest owns only what was shipped.
    expect(readManifest(dest).skills.sort()).toEqual(["alpha", "beta"]);
  });

  it("deletes ONLY a previously-shipped skill that is no longer shipped", () => {
    // Round 1: ship alpha + gamma.
    makeSkill(source, "alpha");
    makeSkill(source, "gamma");
    syncBundledSkills({ source, dest, version: "1" });
    expect(existsSync(join(dest, "gamma"))).toBe(true);

    // Round 2: drop gamma from the shipped set.
    rmSync(join(source, "gamma"), { recursive: true, force: true });
    const r = syncBundledSkills({ source, dest, version: "2" });

    expect(r.removed).toEqual(["gamma"]);
    expect(existsSync(join(dest, "gamma"))).toBe(false);
    expect(existsSync(join(dest, "alpha"))).toBe(true);
    expect(readManifest(dest).skills).toEqual(["alpha"]);
  });

  it("updates an existing shipped skill's contents in place", () => {
    makeSkill(source, "alpha", "V1");
    syncBundledSkills({ source, dest, version: "1" });
    expect(skillBody(dest, "alpha")).toContain("V1");

    makeSkill(source, "alpha", "V2");
    const r = syncBundledSkills({ source, dest, version: "2" });
    expect(r.updated).toContain("alpha");
    expect(skillBody(dest, "alpha")).toContain("V2");
  });

  it("fails closed on a corrupt manifest: deletes nothing, rewrites a clean manifest", () => {
    // Round 1 establishes gamma as owned.
    makeSkill(source, "alpha");
    makeSkill(source, "gamma");
    syncBundledSkills({ source, dest, version: "1" });

    // Corrupt the manifest.
    writeFileSync(join(dest, BUNDLED_SKILL_MANIFEST_NAME), "{ not valid json", "utf8");

    // Round 2 drops gamma. A corrupt manifest must NOT be read as
    // "everything removed" — gamma must survive this run.
    rmSync(join(source, "gamma"), { recursive: true, force: true });
    const r = syncBundledSkills({ source, dest, version: "2" });

    expect(r.manifestCorrupt).toBe(true);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(dest, "gamma"))).toBe(true); // NOT wiped
    // A clean manifest is rewritten for next time.
    expect(readManifest(dest).skills).toEqual(["alpha"]);
  });

  it("is idempotent: a second identical run changes nothing and re-lists no removals", () => {
    makeSkill(source, "alpha");
    makeSkill(source, "beta");
    syncBundledSkills({ source, dest, version: "1" });
    const r2 = syncBundledSkills({ source, dest, version: "1" });
    expect(r2.removed).toEqual([]);
    expect(r2.firstRun).toBe(false);
    expect(existsSync(join(dest, "alpha"))).toBe(true);
    expect(existsSync(join(dest, "beta"))).toBe(true);
  });

  it("leaves no staging temp dirs behind", () => {
    makeSkill(source, "alpha");
    syncBundledSkills({ source, dest, version: "1" });
    const leftovers = existsSync(dest)
      ? require("node:fs").readdirSync(dest).filter((n: string) => n.startsWith(".tmp-") || n.includes(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
  });
});
