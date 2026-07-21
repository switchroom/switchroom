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
import { join, dirname, isAbsolute, relative, resolve } from "node:path";
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

describe("reconcileAgentDefaultSkills — ownership-scoped prune (footgun E)", () => {
  let tmpRoot: string;
  let poolDir: string;
  let agentDir: string;
  let skillsDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-prune-"));
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b", "skill-c"]);
    agentDir = makeAgentDir(tmpRoot, "ag1");
    skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Create a personal-pool skill dir at a PRODUCTION-FAITHFUL path and link the
   * agent to it. Real personal/shared-pool skills live at
   * `~/.switchroom/skills/<name>` (verified on the live host: an agent's
   * coolify link → `~/.switchroom/skills/coolify`). Note the leading
   * dot: `.switchroom` means the path does NOT contain the substring
   * `/switchroom/skills/`, so `isOwnedStaleLink` returns FALSE for it — the
   * refresh path treats it as foreign and spares it. This fixture reproduces
   * that exact shape (a `.switchroom/skills/` root), so the test exercises the
   * real production classification, not an accidental tmp path.
   */
  function makePersonalLink(name: string): string {
    const personalPool = join(tmpRoot, ".switchroom", "skills");
    const target = join(personalPool, name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), `# personal ${name}\n`, "utf-8");
    symlinkSync(target, join(skillsDir, name));
    return target;
  }

  /**
   * Create a link whose target sits under a DEV-CHECKOUT-shaped path
   * (`.../switchroom/skills/<name>`, NO leading dot) — the one shape that DOES
   * contain `/switchroom/skills/`, so `isOwnedStaleLink` returns TRUE. This is
   * the legacy dev-checkout / cross-repo migration case (#1164) the refresh
   * path is meant to heal, distinct from a `.switchroom` personal-pool link.
   */
  function makeDevCheckoutLink(name: string): string {
    const devPool = join(tmpRoot, "switchroom", "skills");
    const target = join(devPool, name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), `# devcheckout ${name}\n`, "utf-8");
    symlinkSync(target, join(skillsDir, name));
    return target;
  }

  it("opt-out REMOVES an existing owned _bundled link", () => {
    // Install the owned link first.
    symlinkSync(join(poolDir, "skill-a"), join(skillsDir, "skill-a"));
    const r = reconcileAgentDefaultSkills(agentDir, { "skill-a": false }, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).toContain("skill-a");
    expect(r.optedOut).toContain("skill-a");
    expect(existsSync(join(skillsDir, "skill-a"))).toBe(false);
  });

  it("opt-out with no existing link prunes nothing (no phantom removal)", () => {
    const r = reconcileAgentDefaultSkills(agentDir, { "skill-a": false }, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).not.toContain("skill-a");
    expect(r.optedOut).toContain("skill-a");
  });

  it("CRITICAL: opt-out NEVER removes a personal-pool link at the same name", () => {
    // A personal skill link named like a default key, target OUTSIDE _bundled.
    makePersonalLink("skill-a");
    const r = reconcileAgentDefaultSkills(agentDir, { "skill-a": false }, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).not.toContain("skill-a");
    // The personal link survives.
    expect(lstatSync(join(skillsDir, "skill-a")).isSymbolicLink()).toBe(true);
  });

  it("CRITICAL: a personal-pool link SURVIVES a converge where its target is transiently missing", () => {
    // Production-shaped personal link (target under `.switchroom/skills/`) at a
    // default-key name, NOT opted out, whose target dir has vanished mid-sync.
    // src (poolDir/skill-a) exists, so this hits the refresh path, not the
    // prune. isOwnedStaleLink is FALSE for a `.switchroom/skills/` target (the
    // dot breaks the `/switchroom/skills/` substring — verified on the live
    // host), so the link is classified foreign and spared.
    const target = makePersonalLink("skill-a");
    rmSync(target, { recursive: true, force: true }); // transiently missing
    const r = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).not.toContain("skill-a");
    // Still a symlink (not deleted / not reclaimed), even though it dangles.
    expect(lstatSync(join(skillsDir, "skill-a")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(skillsDir, "skill-a"))).toBe(target);
  });

  it("REFRESH PATH: a production `.switchroom/skills/` personal link at a default-key name is SPARED (not reclaimed)", () => {
    // The refresh path (review #5): src present, non-opt-out, dest is a
    // personal link named like a default key. On the live host the target is
    // `~/.switchroom/skills/<name>` which does NOT match isOwnedStaleLink, so
    // production spares it (conflict). This fixture reproduces that shape and
    // asserts the real outcome — no ownership clobber.
    const target = makePersonalLink("skill-a");
    const r = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(r.conflicts).toContain("skill-a");
    expect(r.added).not.toContain("skill-a");
    // Still points at the operator's personal skill, NOT the bundled pool.
    expect(readlinkSync(join(skillsDir, "skill-a"))).toBe(target);
  });

  it("REFRESH PATH: a legacy DEV-CHECKOUT `/switchroom/skills/` link at a default-key name IS reclaimed to the pool (#1164 heal)", () => {
    // The one shape that DOES contain `/switchroom/skills/` (no leading dot) —
    // a legacy dev-checkout link. isOwnedStaleLink returns TRUE, so the refresh
    // path heals it to the bundled link. This documents the deliberate migration
    // reclaim and distinguishes it from the `.switchroom` personal-pool case.
    makeDevCheckoutLink("skill-a");
    const r = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(r.added).toContain("skill-a");
    // Now resolves into the bundled pool (reclaimed). Resolve the stored target
    // against the link dir so this holds whether the reclaimed link is written
    // absolute (pre-relative-symlinks) or relative (post-footgun-A) — the merged
    // tree writes it relative.
    const link = join(skillsDir, "skill-a");
    expect(resolve(dirname(link), readlinkSync(link))).toBe(resolve(join(poolDir, "skill-a")));
  });

  it("opt-out NEVER removes a real dir/file at the skill path", () => {
    mkdirSync(join(skillsDir, "skill-a"), { recursive: true });
    writeFileSync(join(skillsDir, "skill-a", "SKILL.md"), "operator content\n", "utf-8");
    const r = reconcileAgentDefaultSkills(agentDir, { "skill-a": false }, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).not.toContain("skill-a");
    expect(lstatSync(join(skillsDir, "skill-a")).isDirectory()).toBe(true);
  });

  it("prunes a DANGLING owned _bundled link when the pool drops the skill", () => {
    // Owned link into the pool, then the pool loses skill-c.
    symlinkSync(join(poolDir, "skill-c"), join(skillsDir, "skill-c"));
    rmSync(join(poolDir, "skill-c"), { recursive: true, force: true });
    const r = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).toContain("skill-c");
    expect(existsSync(join(skillsDir, "skill-c"))).toBe(false);
  });

  it("COMBINED-MERGE: a missing-from-pool default with a dangling owned link is BOTH recorded loudly AND pruned (blocker #2)", () => {
    // The batch-merge of PR1 (loud missing-from-pool) and PR5 (dangling-owned
    // prune) rewrote the SAME `!existsSync(src)` branch. Neither behavior may be
    // lost: the missing builtin default must be recorded (PR1) AND its dangling
    // owned _bundled link must be pruned (PR5), in one pass.
    symlinkSync(join(poolDir, "skill-c"), join(skillsDir, "skill-c"));
    rmSync(join(poolDir, "skill-c"), { recursive: true, force: true });
    const r = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    // PR1 behavior: recorded as missing from the pool (loud packaging error).
    expect(r.missingFromPool).toContain("skill-c");
    // PR5 behavior: the dangling owned link was pruned.
    expect(r.pruned).toContain("skill-c");
    expect(existsSync(join(skillsDir, "skill-c"))).toBe(false);
  });

  it("does not touch a relative owned _bundled link that is still current (no over-prune)", () => {
    // Relative link (post-footgun-A form) that correctly resolves into the pool.
    const rel = relative(dirname(join(skillsDir, "skill-a")), join(poolDir, "skill-a"));
    symlinkSync(rel, join(skillsDir, "skill-a"));
    const r = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(r.pruned).not.toContain("skill-a");
    expect(existsSync(join(skillsDir, "skill-a"))).toBe(true);
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
