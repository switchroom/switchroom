/**
 * #4163: the first `switchroom apply` on a `curl … | sh` host must not
 * scaffold agents against an empty bundled-skills pool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBundledSkillsPool } from "./bootstrap-skills-pool.js";
import { BUNDLED_SKILL_MANIFEST_NAME } from "./sync-bundled-skills.js";

let tmp: string;
let shareRoot: string;
let poolDir: string;

/** A minimal SEA layout: `<prefix>/bin/switchroom` + `<prefix>/share/switchroom/skills`. */
function seaProbe(): { bundleDir: string; execPath: string; env: NodeJS.ProcessEnv } {
  return {
    bundleDir: "/$bunfs/root",
    execPath: join(tmp, "usr", "local", "bin", "switchroom"),
    env: {},
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sr-pool-"));
  shareRoot = join(tmp, "usr", "local", "share", "switchroom");
  poolDir = join(tmp, "home", ".switchroom", "skills", "_bundled");
  for (const name of ["file-bug", "humanizer"]) {
    mkdirSync(join(shareRoot, "skills", name), { recursive: true });
    writeFileSync(join(shareRoot, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("bootstrapBundledSkillsPool", () => {
  it("populates an ABSENT pool from the shipped payload", () => {
    const r = bootstrapBundledSkillsPool({ poolDir, probe: seaProbe(), version: "0.19.44" });
    expect(r.status).toBe("seeded");
    // The outcome that matters is the skill being READABLE at the path
    // scaffold looks in — not merely that the function returned.
    expect(readFileSync(join(poolDir, "file-bug", "SKILL.md"), "utf8")).toContain("file-bug");
    expect(existsSync(join(poolDir, "humanizer", "SKILL.md"))).toBe(true);
  });

  it("writes the same ownership manifest `switchroom update` writes", () => {
    // Otherwise the next `update` sees a manifest-less pool, adopts every dir
    // as operator-owned, and can never retire a skill it shipped.
    bootstrapBundledSkillsPool({ poolDir, probe: seaProbe(), version: "0.19.44" });
    const m = JSON.parse(readFileSync(join(poolDir, BUNDLED_SKILL_MANIFEST_NAME), "utf8"));
    expect(m.version).toBe("0.19.44");
    expect(m.skills.sort()).toEqual(["file-bug", "humanizer"]);
  });

  it("does NOT touch an existing pool — `switchroom update` owns it", () => {
    mkdirSync(join(poolDir, "hand-added"), { recursive: true });
    writeFileSync(join(poolDir, "hand-added", "SKILL.md"), "operator's own\n");
    const r = bootstrapBundledSkillsPool({ poolDir, probe: seaProbe(), version: "0.19.44" });
    expect(r.status).toBe("exists");
    expect(readFileSync(join(poolDir, "hand-added", "SKILL.md"), "utf8")).toBe("operator's own\n");
    // …and nothing was copied in behind the operator's back.
    expect(existsSync(join(poolDir, "file-bug"))).toBe(false);
  });

  it("reports no-payload (and does not throw) when nothing ships skills/", () => {
    rmSync(join(shareRoot, "skills"), { recursive: true, force: true });
    const r = bootstrapBundledSkillsPool({ poolDir, probe: seaProbe(), version: "0.19.44" });
    expect(r.status).toBe("no-payload");
    // apply must still proceed: the pool is simply absent, as before.
    expect(existsSync(poolDir)).toBe(false);
  });
});
