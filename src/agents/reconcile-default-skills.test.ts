/**
 * Unit tests for src/agents/reconcile-default-skills.ts
 *
 * Covers:
 *   (a) symlinks a missing default skill into <agentDir>/.claude/skills/<key>
 *   (b) idempotent — already-correct symlinks are left untouched
 *   (c) refreshes a stale symlink that points elsewhere inside the pool
 *   (d) leaves a foreign symlink (target outside pool) alone, marks conflict
 *   (e) leaves a real dir/file at the destination alone, marks conflict
 *   (f) honours per-agent opt-out (`bundled_skills: { key: false }`)
 *   (g) skips silently when the agent has no .claude/ dir (not yet scaffolded)
 *   (h) skips silently when the pool is missing the skill (trimmed install)
 *   (i) reconcileAllAgentDefaultSkills iterates over agent directories
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Assert `dest` is a switchroom-written skill link (footgun A):
 *   - the stored target is RELATIVE (never absolute — an absolute link
 *     baked with `homedir()` dangles across container mount contexts), and
 *   - it RESOLVES to `expectedPoolTarget` from the link's own directory
 *     (readlink + resolve lands on the pool file — the real invariant).
 * Reading the raw target and resolving it is the only test that would have
 * caught the absolute-link regression.
 */
function expectRelativeLinkResolvingTo(dest: string, expectedPoolTarget: string): void {
  const stored = readlinkSync(dest);
  expect(isAbsolute(stored)).toBe(false);
  expect(resolve(dirname(dest), stored)).toBe(resolve(expectedPoolTarget));
}
import {
  reconcileAgentDefaultSkills,
  reconcileAllAgentDefaultSkills,
  getBundledSkillsPoolDir,
} from "./reconcile-default-skills.js";
import type { BuiltinSkillEntry } from "../memory/scaffold-integration.js";

// Minimal fixture defaults — three named entries are enough to exercise
// add / opt-out / conflict in one pool.
const FIXTURE_DEFAULTS: BuiltinSkillEntry[] = [
  { key: "skill-a", optOutKey: "skill-a", source: "anthropic" },
  { key: "skill-b", optOutKey: "skill-b", source: "anthropic" },
  { key: "skill-c", optOutKey: "skill-c", source: "switchroom" },
];

function makePool(tmpRoot: string, names: string[]): string {
  const poolDir = join(tmpRoot, "pool");
  for (const name of names) {
    const dir = join(poolDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
  }
  return poolDir;
}

function makeAgentDir(tmpRoot: string, name: string, withClaude = true): string {
  const agentDir = join(tmpRoot, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  if (withClaude) mkdirSync(join(agentDir, ".claude"), { recursive: true });
  return agentDir;
}

describe("reconcileAgentDefaultSkills", () => {
  let tmpRoot: string;
  let poolDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-skills-"));
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b", "skill-c"]);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("symlinks every default into <agentDir>/.claude/skills/", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added.sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(result.changed).toBe(true);
    for (const name of ["skill-a", "skill-b", "skill-c"]) {
      const dest = join(agentDir, ".claude", "skills", name);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expectRelativeLinkResolvingTo(dest, join(poolDir, name));
    }
  });

  it("is idempotent — second run produces no additions", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    const second = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent.sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(second.changed).toBe(false);
  });

  it("migrates an existing ABSOLUTE owned link to a relative link (footgun A one-time heal)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Simulate a link baked by the old absolute-target code: it points at
    // the correct pool file but via an ABSOLUTE path — the class that
    // dangles across container mount contexts.
    const dest = join(skillsDir, "skill-a");
    symlinkSync(join(poolDir, "skill-a"), dest);
    expect(isAbsolute(readlinkSync(dest))).toBe(true); // precondition

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    // The migration rewrites it; it is reported as changed (added), and the
    // stored target is now relative but still resolves to the pool file.
    expect(result.added).toContain("skill-a");
    expect(result.changed).toBe(true);
    expectRelativeLinkResolvingTo(dest, join(poolDir, "skill-a"));

    // And it is idempotent afterwards — a second pass sees the relative link
    // as already-correct and does not rewrite it.
    const second = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(second.added).not.toContain("skill-a");
    expect(second.alreadyPresent).toContain("skill-a");
  });

  it("refreshes a stale symlink whose target is inside the pool dir", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Point skill-a at a different (also pool-dir-prefixed) target — simulates
    // a stale link from a renamed skill in the pool.
    const stalePool = join(poolDir, "old-skill-a");
    mkdirSync(stalePool, { recursive: true });
    symlinkSync(stalePool, join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added).toContain("skill-a");
    expectRelativeLinkResolvingTo(join(skillsDir, "skill-a"), join(poolDir, "skill-a"));
  });

  it("leaves a foreign symlink alone and marks it as a conflict", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const foreignTarget = join(tmpRoot, "operator-custom-skill-a");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.conflicts).toContain("skill-a");
    expect(result.added).not.toContain("skill-a");
    expect(readlinkSync(join(skillsDir, "skill-a"))).toBe(foreignTarget);
  });

  it("leaves a real dir at the destination alone and marks it as a conflict", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(join(skillsDir, "skill-a"), { recursive: true });
    writeFileSync(join(skillsDir, "skill-a", "SKILL.md"), "operator hand-rolled\n", "utf-8");

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.conflicts).toContain("skill-a");
    expect(result.added).not.toContain("skill-a");
    // Operator's content survives.
    expect(lstatSync(join(skillsDir, "skill-a")).isDirectory()).toBe(true);
  });

  it("honours per-agent opt-out (`bundled_skills: { key: false }`)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const result = reconcileAgentDefaultSkills(
      agentDir,
      { "skill-b": false },
      FIXTURE_DEFAULTS,
      poolDir,
    );
    expect(result.added.sort()).toEqual(["skill-a", "skill-c"]);
    expect(result.optedOut).toEqual(["skill-b"]);
    expect(existsSync(join(agentDir, ".claude", "skills", "skill-b"))).toBe(false);
  });

  it("skips silently when the agent has no .claude/ directory", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1", /*withClaude*/ false);
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("records a builtin default missing from the pool loudly (footgun C/D), not silently", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    // Re-create the pool without skill-c.
    rmSync(poolDir, { recursive: true, force: true });
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b"]);
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    // The present skills still install...
    expect(result.added.sort()).toEqual(["skill-a", "skill-b"]);
    expect(result.added).not.toContain("skill-c");
    // ...but the missing builtin default is surfaced, not swallowed. This is
    // the assertion that would FAIL under the old silent `continue`.
    expect(result.missingFromPool).toEqual(["skill-c"]);
  });

  it("treats a dangling pool symlink as missing-from-pool, not usable (footgun review #5)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    // Replace skill-c's real dir with a symlink to a nonexistent target so
    // `ls` shows it present but it does not resolve.
    rmSync(join(poolDir, "skill-c"), { recursive: true, force: true });
    symlinkSync(join(tmpRoot, "does-not-exist"), join(poolDir, "skill-c"));
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added).not.toContain("skill-c");
    expect(result.missingFromPool).toEqual(["skill-c"]);
  });
});

describe("reconcileAllAgentDefaultSkills", () => {
  let tmpRoot: string;
  let poolDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-skills-all-"));
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b"]);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("iterates every agent directory and applies opt-outs per agent", () => {
    const agentsDir = join(tmpRoot, "agents");
    makeAgentDir(tmpRoot, "ag1");
    makeAgentDir(tmpRoot, "ag2");
    makeAgentDir(tmpRoot, "ag3");

    const results = reconcileAllAgentDefaultSkills(
      agentsDir,
      { ag2: { "skill-a": false } },
      [
        { key: "skill-a", optOutKey: "skill-a", source: "anthropic" },
        { key: "skill-b", optOutKey: "skill-b", source: "anthropic" },
      ],
      poolDir,
    );

    expect(results).toHaveLength(3);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.ag1.added.sort()).toEqual(["skill-a", "skill-b"]);
    expect(byName.ag2.added).toEqual(["skill-b"]);
    expect(byName.ag2.optedOut).toEqual(["skill-a"]);
    expect(byName.ag3.added.sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("returns [] when the agents dir does not exist", () => {
    const results = reconcileAllAgentDefaultSkills(
      join(tmpRoot, "nonexistent"),
      {},
      FIXTURE_DEFAULTS,
      poolDir,
    );
    expect(results).toEqual([]);
  });
});

describe("getBundledSkillsPoolDir", () => {
  it("resolves under ~/.switchroom/skills/_bundled (host-stable, RCA #1164)", () => {
    const dir = getBundledSkillsPoolDir();
    expect(dir).toBe(join(homedir(), ".switchroom/skills/_bundled"));
  });
});

describe("reconcileAgentDefaultSkills — legacy-prefix migration (#1164)", () => {
  let tmpRoot: string;
  let poolDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-skills-mig-"));
    poolDir = makePool(tmpRoot, ["skill-a"]);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("repoints a symlink whose target was a legacy /opt/skills/* path", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // The legacy target path doesn't have to exist for readlink — we
    // only need lstat to identify a symlink. Create a dangling link.
    symlinkSync("/opt/skills/skill-a", join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(
      agentDir,
      {},
      [{ key: "skill-a", optOutKey: "skill-a", source: "anthropic" }],
      poolDir,
    );
    expect(result.added).toContain("skill-a");
    expectRelativeLinkResolvingTo(join(skillsDir, "skill-a"), join(poolDir, "skill-a"));
  });

  it("repoints a symlink whose target was a legacy */switchroom/skills/* dev-checkout path", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync("/home/dev/code/switchroom/skills/skill-a", join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(
      agentDir,
      {},
      [{ key: "skill-a", optOutKey: "skill-a", source: "anthropic" }],
      poolDir,
    );
    expect(result.added).toContain("skill-a");
    expectRelativeLinkResolvingTo(join(skillsDir, "skill-a"), join(poolDir, "skill-a"));
  });

  it("repoints a symlink whose target was the retired bun-global switchroom-ai/skills path (carrie RCA)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Exact retired legacy shape that left carrie with 7 dangling links:
    // .../node_modules/switchroom-ai/skills/<key> (NOT .../switchroom/skills/).
    // Dangling on purpose — lstat only needs to see a symlink.
    symlinkSync(
      "/home/agent/.bun/install/global/node_modules/switchroom-ai/skills/skill-a",
      join(skillsDir, "skill-a"),
    );

    const result = reconcileAgentDefaultSkills(
      agentDir,
      {},
      [{ key: "skill-a", optOutKey: "skill-a", source: "anthropic" }],
      poolDir,
    );
    // Owned-stale: link is deleted and recreated pointing into the current pool.
    expect(result.added).toContain("skill-a");
    expect(result.conflicts).not.toContain("skill-a");
    expectRelativeLinkResolvingTo(join(skillsDir, "skill-a"), join(poolDir, "skill-a"));
  });

  it("leaves a genuinely foreign switchroom-ai-like path alone (no over-match)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Operator-custom location — resembles nothing switchroom owns; must be
    // preserved as a conflict, proving the legacy matcher isn't a blanket match.
    const foreignTarget = join(tmpRoot, "custom", "skills", "skill-a");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(
      agentDir,
      {},
      [{ key: "skill-a", optOutKey: "skill-a", source: "anthropic" }],
      poolDir,
    );
    expect(result.conflicts).toContain("skill-a");
    expect(result.added).not.toContain("skill-a");
    expect(readlinkSync(join(skillsDir, "skill-a"))).toBe(foreignTarget);
  });
});

describe("getBuiltinDefaultSkillEntries", () => {
  it("ships the expected anthropic + switchroom-core defaults", async () => {
    const { getBuiltinDefaultSkillEntries } = await import(
      "../memory/scaffold-integration.js"
    );
    const entries = getBuiltinDefaultSkillEntries();
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      "dev-protocol",
      "docx",
      "mcp-builder",
      "mental-model-curator",
      "pdf",
      "pptx",
      "skill-creator",
      "switchroom-cli",
      "switchroom-health",
      "switchroom-runtime",
      "switchroom-status",
      "telegram-formatting",
      "webapp-testing",
      "xlsx",
    ]);
    // optOutKey is always equal to key today; pin so future renames are deliberate.
    for (const e of entries) {
      expect(e.optOutKey).toBe(e.key);
    }
    // Source attribution is honest about provenance.
    const switchroomEntries = entries.filter((e) => e.source === "switchroom").map((e) => e.key);
    expect(switchroomEntries.sort()).toEqual([
      "dev-protocol",
      "mental-model-curator",
      "switchroom-cli",
      "switchroom-health",
      "switchroom-runtime",
      "switchroom-status",
      "telegram-formatting",
    ]);
  });
});

/**
 * Packaging guard (footgun C/D) — the deterministic build-time backstop.
 *
 * Every entry in `getBuiltinDefaultSkillEntries()` is symlinked into every
 * agent's `.claude/skills/` and referenced from the generated CLAUDE.md.
 * `switchroom update` copies the repo `skills/` dir into the runtime pool
 * (`~/.switchroom/skills/_bundled/`), so a declared default that has no
 * `skills/<key>/` dir in the package becomes a "ghost skill": referenced
 * everywhere, shipped nowhere (the live dev-protocol / mental-model-curator
 * incident). This test fails the moment the declared-defaults list and the
 * shipped `skills/` dir diverge — the class cannot recur silently.
 *
 * It reads the list at RUNTIME (never a hardcoded copy) so editing the
 * defaults list without shipping the skill trips this immediately.
 */
describe("packaging: every builtin default skill ships in the repo skills/ dir", () => {
  it("has a skills/<key>/SKILL.md for every getBuiltinDefaultSkillEntries() key", async () => {
    const { fileURLToPath } = await import("node:url");
    const { getBuiltinDefaultSkillEntries } = await import(
      "../memory/scaffold-integration.js"
    );
    // src/agents/<thisfile> → repo root is two levels up; skills/ sits beside src/.
    const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
    const skillsDir = join(repoRoot, "skills");
    // Sanity: the skills/ dir itself must exist, or the guard is vacuous.
    expect(existsSync(skillsDir)).toBe(true);

    const missing = getBuiltinDefaultSkillEntries()
      .map((e) => e.key)
      .filter((key) => !existsSync(join(skillsDir, key, "SKILL.md")));
    expect(missing).toEqual([]);
  });
});
