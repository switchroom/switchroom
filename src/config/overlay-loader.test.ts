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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentOverlays, OVERLAY_SOURCE } from "./overlay-loader.js";
import type { SwitchroomConfig } from "./schema.js";

/**
 * Build a minimal SwitchroomConfig with the given agents. We bypass the full
 * SwitchroomConfigSchema here — the overlay loader only touches
 * `switchroom.agents.<name>.schedule`, so we construct just enough shape to
 * exercise it. Cast through `unknown` to keep TS quiet about the partial
 * shape.
 */
function makeConfig(
  agents: Record<string, { schedule?: unknown[] }>,
): SwitchroomConfig {
  return {
    switchroom: {
      agents: agents as Record<string, never>,
    },
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
    expect(cfg.switchroom.agents.foo.schedule).toHaveLength(1);
  });

  it("is a no-op when the overlay directory exists but is empty", () => {
    overlayDir("foo");
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    expect(cfg.switchroom.agents.foo.schedule).toEqual([]);
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
    const sched = cfg.switchroom.agents.foo.schedule as Array<{ prompt: string }>;
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
    const sched = cfg.switchroom.agents.foo.schedule as Array<{ prompt: string }>;
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
    expect(cfg.switchroom.agents.foo.schedule).toHaveLength(1);
  });

  it("accepts both .yaml and .yml extensions", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "a.yml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: from-yml\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    applyAgentOverlays(cfg);
    expect(cfg.switchroom.agents.foo.schedule).toHaveLength(1);
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
    expect(cfg.switchroom.agents.foo.schedule).toHaveLength(1);
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
    expect(cfg.switchroom.agents.foo.schedule).toEqual([]);
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
    const sched = cfg.switchroom.agents.foo.schedule as Array<{ prompt: string }>;
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
    expect(cfg.switchroom.agents["agent-y"].schedule).toHaveLength(1);
  });

  it("handles agents with no schedule (treats undefined as empty)", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "a.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: only\n");
    const cfg = makeConfig({ foo: {} });
    applyAgentOverlays(cfg);
    expect(cfg.switchroom.agents.foo.schedule).toHaveLength(1);
  });

  it("stamps overlay-sourced entries with the OVERLAY_SOURCE symbol (non-enumerable)", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "a.yaml"), "schedule:\n  - cron: '0 1 * * *'\n    prompt: marked\n");
    const cfg = makeConfig({
      foo: { schedule: [{ cron: "0 0 * * *", prompt: "main", secrets: [] }] },
    });
    applyAgentOverlays(cfg);
    const sched = cfg.switchroom.agents.foo.schedule as Array<Record<symbol, unknown>>;
    // Main entry not stamped.
    expect(sched[0][OVERLAY_SOURCE]).toBeUndefined();
    // Overlay entry stamped.
    expect(sched[1][OVERLAY_SOURCE]).toBe(true);
    // Marker is non-enumerable: JSON.stringify must not surface it.
    const json = JSON.stringify(sched[1]);
    expect(json).not.toMatch(/overlay-source/i);
  });

  it("accepts an empty overlay document (no schedule key)", () => {
    const dir = overlayDir("foo");
    writeFileSync(join(dir, "empty.yaml"), "{}\n");
    const cfg = makeConfig({ foo: { schedule: [] } });
    const { warnings } = applyAgentOverlays(cfg);
    expect(warnings).toEqual([]);
    expect(cfg.switchroom.agents.foo.schedule).toEqual([]);
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
