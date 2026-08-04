/**
 * Tests for applyAgentOverlays (switchroom #1163, Phase B).
 *
 * Covers:
 *   - no overlay dir is a no-op (no warnings, schedule unchanged)
 *   - overlay schedule entries are appended (precedence: main entries first,
 *     overlay entries after)
 *   - multiple overlay files load in sorted (deterministic) order
 *   - non-yaml files in the dir are ignored
 *   - malformed YAML produces a per-file warning and never throws
 *   - schema rejection (unknown top-level key, bad entry) is per-file isolated
 *   - secrets-bearing entries are dropped with a warning
 *   - per-agent isolation: agent X's broken overlay does not prevent
 *     agent Y from loading cleanly
 *   - overlay-sourced entries are stamped with the OVERLAY_SOURCE symbol
 *     (non-enumerable so JSON.stringify ignores them)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAgentOverlays,
  overlayReadFailures,
  OVERLAY_SOURCE,
  OVERLAY_TITLE,
} from "./overlay-loader.js";
import type { SwitchroomConfig } from "./schema.js";

/**
 * Build a minimal SwitchroomConfig with the given agents. We bypass the full
 * SwitchroomConfigSchema here — the overlay loader only touches
 * `switchroom.agents.<name>.schedule`, so we construct just enough shape to
 * exercise it. Cast through `unknown` to keep TS quiet about the partial
 * shape.
 */
function makeConfig(
  agents: Record<string, { schedule?: unknown[]; skills?: string[] }>,
): SwitchroomConfig {
  // `agents` lives at the TOP level of `SwitchroomConfig`, alongside
  // `switchroom`, `telegram`, `defaults`, `profiles` — NOT inside the
  // inner `switchroom:` block. Pre-#1200 the fixture put it under
  // `switchroom.agents` (matching the bug in overlay-loader.ts:113
  // which read `config.switchroom?.agents`), so the test silently
  // passed against a no-op loader. Both halves fixed together.
  return {
    agents: agents as Record<string, never>,
  } as unknown as SwitchroomConfig;
}

describe("applyAgentOverlays", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "overlay-loader-test-"));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    warnSpy.mockRestore();
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  function overlayDir(agentName: string): string {
    const dir = join(tmpHome, ".switchroom", "agents", agentName, "schedule.d");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("is a no-op when no overlay directory exists", () => {
    const cfg = makeConfig({
      foo: { schedule: [{ cron: "0 * * * *", prompt: "main", secrets: [] }] },
    });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    expect(cfg.agents.foo.schedule).toHaveLength(1);
  });

  it("is a no-op when the overlay directory exists but is empty", () => {
    overlayDir("foo");
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    expect(cfg.agents.foo.schedule).toEqual([]);
  });

  it("appends overlay schedule entries AFTER main-config entries (precedence)", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "a.yaml"),
      "schedule:\n  - cron: '0 1 * * *'\n    prompt: overlay-entry\n",
    );
    const cfg = makeConfig({
      foo: { schedule: [{ cron: "0 0 * * *", prompt: "main-entry", secrets: [] }] },
    });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    const sched = cfg.agents.foo.schedule as Array<{ prompt: string }>;
    expect(sched).toHaveLength(2);
    expect(sched[0].prompt).toBe("main-entry");
    expect(sched[1].prompt).toBe("overlay-entry");
  });

  it("loads multiple overlay files in sorted order (deterministic)", () => {
    const dir = overlayDir("foo");
    // Write out-of-order; loader sorts by filename.
    writeFileSync(join(dir, "z-second.yaml"), "schedule:\n  - cron: '0 2 * * *'\n    prompt: second\n");
    writeFileSync(join(dir, "a-first.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: first\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<{ prompt: string }>;
    expect(sched.map((e) => e.prompt)).toEqual(["first", "second"]);
  });

  it("ignores non-yaml files in the overlay dir", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "notes.txt"), "not yaml");
    writeFileSync(join(dir, "README.md"), "# nope");
    writeFileSync(join(dir, "real.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: ok\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    expect(cfg.agents.foo.schedule).toHaveLength(1);
  });

  it("accepts both .yaml and .yml extensions", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "a.yml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: from-yml\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    expect(cfg.agents.foo.schedule).toHaveLength(1);
  });

  it("emits a warning and isolates the file when YAML is malformed", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "broken.yaml"), "schedule: [unterminated\n");
    writeFileSync(join(dir, "good.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: good\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].file).toMatch(/broken\.yaml$/);
    expect(warnings[0].reason).toMatch(/parse error|schema/i);
    // Good file still loaded.
    expect(cfg.agents.foo.schedule).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("emits a warning when an overlay declares an unknown top-level key", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "typo.yaml"),
      "schedule: []\nagents:\n  evil: {}\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/schema rejection/);
  });

  it("emits a warning when a schedule entry is missing required fields", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "bad-entry.yaml"),
      "schedule:\n  - cron: '0 1 * * *'\n", // missing prompt
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/schema rejection/);
    expect(cfg.agents.foo.schedule).toEqual([]);
  });

  it("drops overlay entries that declare secrets, with a warning", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "with-secrets.yaml"),
      "schedule:\n" +
        "  - cron: '0 1 * * *'\n" +
        "    prompt: needs-secret\n" +
        "    secrets:\n" +
        "      - api/key\n" +
        "  - cron: '0 2 * * *'\n" +
        "    prompt: clean-entry\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/secrets/);
    const sched = cfg.agents.foo.schedule as Array<{ prompt: string }>;
    expect(sched).toHaveLength(1);
    expect(sched[0].prompt).toBe("clean-entry");
  });

  it("isolates failures per agent (broken X does not block clean Y)", () => {
    const dirX = overlayDir("agent-x");
    writeFileSync(join(dirX, "bad.yaml"), "schedule: [unterminated\n");
    const dirY = overlayDir("agent-y");
    writeFileSync(join(dirY, "ok.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: y-ok\n");
    const cfg = makeConfig({
      "agent-x": { schedule: [] },
      "agent-y": { schedule: [] },
    });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings.some((w) => w.agent === "agent-x")).toBe(true);
    expect(cfg.agents["agent-y"].schedule).toHaveLength(1);
  });

  it("handles agents with no schedule (treats undefined as empty)", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "a.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: only\n");
    const cfg = makeConfig({ foo: {} });
    applyAgentOverlays(cfg);
    expect(cfg.agents.foo.schedule).toHaveLength(1);
  });

  it("stamps overlay-sourced entries with the OVERLAY_SOURCE symbol (non-enumerable)", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "a.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: marked\n");
    const cfg = makeConfig({
      foo: { schedule: [{ cron: "0 0 * * *", prompt: "main", secrets: [] }] },
    });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<Record<symbol, unknown>>;
    // Main entry not stamped.
    expect(sched[0][OVERLAY_SOURCE]).toBeUndefined();
    // Overlay entry stamped.
    expect(sched[1][OVERLAY_SOURCE]).toBe(true);
    // Marker is non-enumerable: JSON.stringify must not surface it.
    const json = JSON.stringify(sched[1]);
    expect(json).not.toMatch(/overlay-source/i);
  });

  it("stamps OVERLAY_TITLE from a top-of-file `# name:` comment", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "cron-deadbeef99.yaml"),
      "# name: school-alerts-linear\n" +
        "schedule:\n  - cron: '0 7 * * *'\n    prompt: check school portal\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<Record<symbol, unknown>>;
    expect(sched).toHaveLength(1);
    // The `# name:` comment is authoritative even though the FILENAME is a
    // generic cron-<hash> auto-name.
    expect(sched[0][OVERLAY_TITLE]).toBe("school-alerts-linear");
    // Non-enumerable: JSON.stringify must not surface it.
    expect(JSON.stringify(sched[0])).not.toMatch(/overlay-title|school-alerts/i);
  });

  it("does not bleed the next line into the title for a whitespace-only `# name:` header", () => {
    const dir = overlayDir("foo");
    // A malformed empty-value `# name:` header must NOT pull `schedule:` (the
    // next line) in as the title — the regex stays on the comment's own line.
    writeFileSync(
      join(dir, "cron-feedface11.yaml"),
      "# name:   \n" + "schedule:\n  - cron: '0 8 * * *'\n    prompt: p\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<Record<symbol, unknown>>;
    // No `# name:` value + hash-only filename → no title at all.
    expect(sched[0][OVERLAY_TITLE]).toBeUndefined();
  });

  it("leaves OVERLAY_TITLE undefined for a hash-only cron-<hash>.yaml with no `# name:`", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "cron-1a2b3c4d5e.yaml"),
      "schedule:\n  - cron: '0 8 * * *'\n    prompt: no title here\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<Record<symbol, unknown>>;
    expect(sched).toHaveLength(1);
    // A hash is not a meaningful title — must NOT be used as one.
    expect(sched[0][OVERLAY_TITLE]).toBeUndefined();
  });

  it("derives OVERLAY_TITLE from a hand-named filename when there's no `# name:` comment", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "weekend-planner.yaml"),
      "schedule:\n  - cron: '0 9 * * 6'\n    prompt: plan the weekend\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<Record<symbol, unknown>>;
    expect(sched).toHaveLength(1);
    expect(sched[0][OVERLAY_TITLE]).toBe("weekend-planner");
  });

  it("stamps the SAME title on every entry a multi-entry overlay file declares", () => {
    const dir = overlayDir("foo");
    writeFileSync(
      join(dir, "morning-suite.yaml"),
      "schedule:\n" +
        "  - cron: '0 7 * * *'\n    prompt: first\n" +
        "  - cron: '0 8 * * *'\n    prompt: second\n",
    );
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    const sched = cfg.agents.foo.schedule as Array<Record<symbol, unknown>>;
    expect(sched).toHaveLength(2);
    expect(sched[0][OVERLAY_TITLE]).toBe("morning-suite");
    expect(sched[1][OVERLAY_TITLE]).toBe("morning-suite");
  });

  it("accepts an empty overlay document (no schedule key)", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "empty.yaml"), "{}\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    expect(cfg.agents.foo.schedule).toEqual([]);
  });

  it("returns the config object it was given (mutates in place)", () => {
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { config } = applyAgentOverlays(cfg);
    expect(config).toBe(cfg);
  });

  it("handles a config with no agents at all", () => {
    const cfg = makeConfig({});
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
  });
});

// chmod 0o000 does not stop root from reading — the unreadable-file
// simulation only works for an unprivileged test uid.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(runningAsRoot)(
  "applyAgentOverlays — unreadable overlay files (EACCES drop incident)",
  () => {
    // Regression guards for the clerk incident: a root-euid writer left
    // schedule.d/cron-*.yaml root-owned 0600; the in-container loader
    // EACCESed, logged "parse error: EACCES", and SILENTLY excluded the
    // file's entries — indistinguishable (to callers) from the file having
    // been deleted, so the scheduler's hot-reload unregistered live crons.
    // The fix classifies READ failures separately from content failures
    // and surfaces them via overlayReadFailures().

    let tmpHome: string;
    let prevHome: string | undefined;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), "overlay-loader-eacces-"));
      prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      warnSpy.mockRestore();
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch { /* best-effort */ }
    });

    function scheduleDir(agentName: string): string {
      const dir = join(tmpHome, ".switchroom", "agents", agentName, "schedule.d");
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it("classifies an unreadable file as a READ failure (code=EACCES), not a content failure", () => {
      const dir = scheduleDir("foo");
      const locked = join(dir, "cron-aaaaaaaaaaaa.yaml");
      writeFileSync(locked, "schedule:\n  - cron: '0 1 * * *'\n    prompt: hidden\n");
      chmodSync(locked, 0o000);
      const cfg = makeConfig({ foo: { schedule: [] } });
      const { warnings } = applyAgentOverlays(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe("EACCES");
      expect(warnings[0].reason).toMatch(/read error/);
      const failures = overlayReadFailures(cfg, "foo");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ file: locked, code: "EACCES" });
    });

    it("still loads readable sibling files (per-file isolation preserved)", () => {
      const dir = scheduleDir("foo");
      const locked = join(dir, "cron-bbbbbbbbbbbb.yaml");
      writeFileSync(locked, "schedule:\n  - cron: '0 1 * * *'\n    prompt: hidden\n");
      chmodSync(locked, 0o000);
      writeFileSync(join(dir, "good.yaml"), "schedule:\n  - cron: '0 2 * * *'\n    prompt: ok\n");
      const cfg = makeConfig({
        foo: { schedule: [{ cron: "0 0 * * *", prompt: "main", secrets: [] }] },
      });
      applyAgentOverlays(cfg);
      const sched = cfg.agents.foo.schedule as Array<{ prompt: string }>;
      expect(sched.map((e) => e.prompt)).toEqual(["main", "ok"]);
    });

    it("does NOT report content failures (malformed YAML) as read failures", () => {
      const dir = scheduleDir("foo");
      writeFileSync(join(dir, "broken.yaml"), "schedule: [unterminated\n");
      const cfg = makeConfig({ foo: { schedule: [] } });
      const { warnings } = applyAgentOverlays(cfg);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBeUndefined();
      expect(overlayReadFailures(cfg, "foo")).toEqual([]);
    });

    it("reports an unreadable skills.d file too", () => {
      const dir = join(tmpHome, ".switchroom", "agents", "foo", "skills.d");
      mkdirSync(dir, { recursive: true });
      const locked = join(dir, "ws.yaml");
      writeFileSync(locked, "skills:\n  - webapp-testing\n");
      chmodSync(locked, 0o000);
      const cfg = makeConfig({ foo: { skills: [] } });
      const { warnings } = applyAgentOverlays(cfg);
      expect(warnings.some((w) => w.code === "EACCES" && w.file === locked)).toBe(true);
      expect(overlayReadFailures(cfg, "foo")).toContainEqual({ file: locked, code: "EACCES" });
    });

    it("reports an unreadable schedule.d DIRECTORY as a read failure (dir-level variant)", () => {
      const dir = scheduleDir("foo");
      writeFileSync(join(dir, "cron-dddddddddddd.yaml"), "schedule: []\n");
      chmodSync(dir, 0o000);
      try {
        const cfg = makeConfig({ foo: { schedule: [] } });
        const { warnings } = applyAgentOverlays(cfg);
        expect(warnings.some((w) => w.file === dir && w.code === "EACCES")).toBe(true);
        expect(overlayReadFailures(cfg, "foo")).toContainEqual({ file: dir, code: "EACCES" });
      } finally {
        chmodSync(dir, 0o755); // so afterEach rmSync can clean up
      }
    });

    it("returns [] for an agent with no read failures / unknown agent", () => {
      const cfg = makeConfig({ foo: { schedule: [] } });
      applyAgentOverlays(cfg);
      expect(overlayReadFailures(cfg, "foo")).toEqual([]);
      expect(overlayReadFailures(cfg, "nope")).toEqual([]);
    });

    it("keeps the read-failure marker non-enumerable (invisible to JSON paths)", () => {
      const dir = scheduleDir("foo");
      const locked = join(dir, "cron-cccccccccccc.yaml");
      writeFileSync(locked, "schedule: []\n");
      chmodSync(locked, 0o000);
      const cfg = makeConfig({ foo: { schedule: [] } });
      applyAgentOverlays(cfg);
      expect(overlayReadFailures(cfg, "foo")).toHaveLength(1);
      expect(JSON.stringify(cfg.agents.foo)).not.toMatch(/read-failures|EACCES/i);
    });
  },
);

describe("applyAgentOverlays — skills.d pass (#1163 Phase 2)", () => {
  // Regression guard for the #1209 review finding: pre-fix the
  // schedule.d pass had an early `continue` that skipped the skills.d
  // pass entirely when an agent had no schedule.d files. Newly-
  // scaffolded agents (the common case) would silently lose their
  // overlay-installed skills.

  let tmpHome2: string;
  let prevHome2: string | undefined;
  let warnSpy2: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome2 = mkdtempSync(join(tmpdir(), "overlay-loader-skills-"));
    prevHome2 = process.env.HOME;
    process.env.HOME = tmpHome2;
    warnSpy2 = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevHome2 === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome2;
    warnSpy2.mockRestore();
    try {
      rmSync(tmpHome2, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  function writeSkillsOverlay(agent: string, slug: string, skills: string[]) {
    const dir = join(tmpHome2, ".switchroom", "agents", agent, "skills.d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.yaml`), `skills:\n${skills.map((s) => `  - ${s}`).join("\n")}\n`);
  }

  it("merges skills.d entries even when schedule.d is empty (#1209 regression)", () => {
    writeSkillsOverlay("foo", "ws", ["webapp-testing"]);
    const cfg = makeConfig({ foo: { skills: [] } });
    const { config } = applyAgentOverlays(cfg);
    expect(config.agents.foo.skills).toEqual(["webapp-testing"]);
  });

  it("appends overlay skills AFTER main-config skills", () => {
    writeSkillsOverlay("foo", "wt", ["webapp-testing"]);
    const cfg = makeConfig({ foo: { skills: ["operator-installed"] } });
    const { config } = applyAgentOverlays(cfg);
    expect(config.agents.foo.skills).toEqual([
      "operator-installed",
      "webapp-testing",
    ]);
  });

  it("dedupes skills across overlay + main-config (main wins)", () => {
    writeSkillsOverlay("foo", "dup", ["webapp-testing", "pdf"]);
    const cfg = makeConfig({ foo: { skills: ["webapp-testing"] } });
    const { config } = applyAgentOverlays(cfg);
    // webapp-testing kept once (from main); pdf appended once.
    expect(config.agents.foo.skills).toEqual(["webapp-testing", "pdf"]);
  });

  it("loads multiple overlay files in sorted order, deduping cross-file", () => {
    writeSkillsOverlay("foo", "a", ["alpha"]);
    writeSkillsOverlay("foo", "b", ["beta", "alpha"]);   // alpha dup
    writeSkillsOverlay("foo", "c", ["gamma"]);
    const cfg = makeConfig({ foo: { skills: [] } });
    const { config } = applyAgentOverlays(cfg);
    expect(config.agents.foo.skills).toEqual(["alpha", "beta", "gamma"]);
  });

  it("is a no-op when no skills.d directory exists", () => {
    const cfg = makeConfig({ foo: { skills: ["existing"] } });
    const { config, warnings } = applyAgentOverlays(cfg);
    expect(config.agents.foo.skills).toEqual(["existing"]);
    expect(warnings).toEqual([]);
  });

  it("per-file failure isolation: bad YAML doesn't block good files", () => {
    writeSkillsOverlay("foo", "good", ["alpha"]);
    const dir = join(tmpHome2, ".switchroom", "agents", "foo", "skills.d");
    writeFileSync(join(dir, "bad.yaml"), "skills: [malformed");
    const cfg = makeConfig({ foo: { skills: [] } });
    const { config, warnings } = applyAgentOverlays(cfg);
    expect(config.agents.foo.skills).toEqual(["alpha"]);
    expect(warnings.some((w) => w.file.endsWith("bad.yaml"))).toBe(true);
  });

  it("loads BOTH schedule.d and skills.d when both populated", () => {
    // Pin that the schedule-fix doesn't regress when skills.d is also present.
    const dirSched = join(tmpHome2, ".switchroom", "agents", "foo", "schedule.d");
    mkdirSync(dirSched, { recursive: true });
    writeFileSync(
      join(dirSched, "ping.yaml"),
      "schedule:\n  - cron: \"*/10 * * * *\"\n    prompt: \"ping\"\n",
    );
    writeSkillsOverlay("foo", "ws", ["webapp-testing"]);
    const cfg = makeConfig({ foo: { schedule: [], skills: [] } });
    const { config } = applyAgentOverlays(cfg);
    expect((config.agents.foo.schedule as unknown[])).toHaveLength(1);
    expect(config.agents.foo.skills).toEqual(["webapp-testing"]);
  });
});
