import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHindsightPlugin } from "../src/agents/scaffold.js";
import { detectHindsightRecallTunableDrift } from "../src/agents/drift.js";
import {
  resolveHindsightRecallTunables,
  readHooksRecallTimeout,
  renderHindsightHooksOverrides,
  DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS,
  DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS,
  RECALL_DEADLINE_HEADROOM_SECONDS,
} from "../src/setup/hindsight-recall-tunables.js";
import type { SwitchroomConfig, AgentConfig } from "../src/config/schema.js";

/**
 * The bug these tests guard.
 *
 * The recall latency envelope — the UserPromptSubmit hook ceiling, the shared
 * parallel fan-out deadline, and the per-bank HTTP timeout — used to live as
 * LITERALS inside the vendored hindsight plugin (`hooks/hooks.json` "timeout":
 * 12, `scripts/recall.py` `timeout=8`), with `recallParallelDeadlineSeconds`
 * having no switchroom-side resolution at all.
 *
 * `installHindsightPlugin` rm's and re-copies that tree from `vendor/` on every
 * reconcile, so tuning any of them meant hand-editing the installed plugin and
 * watching the next `switchroom apply` throw the edit away. That happened at
 * least three separate times on the live fleet, silently, each time reverting
 * recall to shipped defaults while switchroom.yaml still read as though it were
 * tuned.
 *
 * So the load-bearing assertion in this file is NOT "the installer writes the
 * value once". It is "the value is still correct AFTER a reinstall that has
 * clobbered it" — a test that only checked the first install would stay green
 * through the exact regression it is supposed to catch.
 */

const PLUGIN_REL = [".claude", "plugins", "hindsight-memory"] as const;

function configFor(recall: unknown): SwitchroomConfig {
  return {
    agents: { probe: { memory: { recall } } },
    memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
    telegram: { bot_token: "t", forum_chat_id: "c" },
  } as unknown as SwitchroomConfig;
}

describe("recall latency tunables are declarative and survive apply", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `scaffold-recall-tunables-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  const settingsPath = () => join(tmpDir, ...PLUGIN_REL, "settings.json");
  const hooksPath = () => join(tmpDir, ...PLUGIN_REL, "hooks", "hooks.json");

  const readSettings = () =>
    JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;
  const readHookTimeout = () => readHooksRecallTimeout(readFileSync(hooksPath(), "utf-8"));

  it("stamps the configured envelope into the installed plugin", () => {
    const config = configFor({
      hook_timeout_seconds: 20,
      parallel_deadline_seconds: 17,
      request_timeout_seconds: 13,
    });
    expect(installHindsightPlugin("probe", tmpDir, config)).not.toBeNull();

    expect(readHookTimeout()).toBe(20);
    const s = readSettings();
    expect(s.recallParallelDeadlineSeconds).toBe(17);
    expect(s.recallRequestTimeoutSeconds).toBe(13);
  });

  /**
   * THE regression test. Reproduces the real-world sequence: an operator (or an
   * earlier switchroom version) leaves the installed plugin carrying the OLD
   * hard-coded literals, then an apply runs. Before this change the apply
   * re-copied the vendor literals and the configured values were lost; now the
   * apply must RE-ASSERT them.
   */
  it("re-asserts the configured values when a reinstall has clobbered them", () => {
    const config = configFor({
      hook_timeout_seconds: 20,
      parallel_deadline_seconds: 17,
      request_timeout_seconds: 13,
    });
    installHindsightPlugin("probe", tmpDir, config);

    // Clobber the deployed plugin back to the pre-fix literals, exactly as a
    // vendor re-copy would.
    const hooks = JSON.parse(readFileSync(hooksPath(), "utf-8"));
    for (const m of hooks.hooks.UserPromptSubmit) {
      for (const h of m.hooks) if (h.command.includes("recall.py")) h.timeout = 12;
    }
    writeFileSync(hooksPath(), JSON.stringify(hooks, null, 2) + "\n");

    const clobbered = readSettings();
    delete clobbered.recallParallelDeadlineSeconds;
    delete clobbered.recallRequestTimeoutSeconds;
    writeFileSync(settingsPath(), JSON.stringify(clobbered, null, 2) + "\n");

    // Sanity: the clobber actually took, so a green result below means the
    // re-stamp ran rather than the tamper having silently failed.
    expect(readHookTimeout()).toBe(12);
    expect(readSettings().recallParallelDeadlineSeconds).toBeUndefined();

    // The apply.
    installHindsightPlugin("probe", tmpDir, config);

    expect(readHookTimeout()).toBe(20);
    const s = readSettings();
    expect(s.recallParallelDeadlineSeconds).toBe(17);
    expect(s.recallRequestTimeoutSeconds).toBe(13);
  });

  it("keeps re-asserting across repeated applies (idempotent, not one-shot)", () => {
    const config = configFor({ hook_timeout_seconds: 18, request_timeout_seconds: 11 });
    for (let i = 0; i < 3; i++) installHindsightPlugin("probe", tmpDir, config);
    expect(readHookTimeout()).toBe(18);
    // deadline derives from the ceiling: 18 - 2 headroom
    expect(readSettings().recallParallelDeadlineSeconds).toBe(16);
    expect(readSettings().recallRequestTimeoutSeconds).toBe(11);
  });

  it("an apply that changes the yaml value moves the installed value", () => {
    installHindsightPlugin("probe", tmpDir, configFor({ hook_timeout_seconds: 20 }));
    expect(readHookTimeout()).toBe(20);
    // Operator edits switchroom.yaml, re-applies.
    installHindsightPlugin("probe", tmpDir, configFor({ hook_timeout_seconds: 9 }));
    expect(readHookTimeout()).toBe(9);
    expect(readSettings().recallParallelDeadlineSeconds).toBe(7);
  });

  it("ships the historical defaults when nothing is configured", () => {
    installHindsightPlugin("probe", tmpDir, configFor(undefined));
    // These are the values the plugin carried as literals before promotion —
    // promotion must not change what switchroom ships.
    expect(readHookTimeout()).toBe(12);
    expect(readSettings().recallParallelDeadlineSeconds).toBe(10);
    expect(readSettings().recallRequestTimeoutSeconds).toBe(8);
  });

  it("leaves the vendor tree untouched", () => {
    const config = configFor({ hook_timeout_seconds: 30 });
    installHindsightPlugin("probe", tmpDir, config);
    // The vendor source must still carry the shipped literals — switchroom
    // stamps the DEPLOYED copy, never the checked-in one.
    const vendorHooks = readFileSync(
      join(process.cwd(), "vendor", "hindsight-memory", "hooks", "hooks.json"),
      "utf-8",
    );
    expect(readHooksRecallTimeout(vendorHooks)).toBe(DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS);
  });
});

describe("drift row: installed plugin vs switchroom.yaml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `drift-recall-tunables-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  const recall = {
    hook_timeout_seconds: 20,
    parallel_deadline_seconds: 17,
    request_timeout_seconds: 13,
  };
  const config = () => configFor(recall);
  const agentConfig = () => ({ memory: { recall } }) as unknown as AgentConfig;

  it("is silent when the installed plugin matches the config", () => {
    installHindsightPlugin("probe", tmpDir, config());
    const f = detectHindsightRecallTunableDrift("probe", agentConfig(), tmpDir, config());
    expect(f).toEqual([]);
  });

  it("FAILS when the hook ceiling has been reverted underneath us", () => {
    installHindsightPlugin("probe", tmpDir, config());
    const p = join(tmpDir, ...PLUGIN_REL, "hooks", "hooks.json");
    const hooks = JSON.parse(readFileSync(p, "utf-8"));
    for (const m of hooks.hooks.UserPromptSubmit) {
      for (const h of m.hooks) if (h.command.includes("recall.py")) h.timeout = 12;
    }
    writeFileSync(p, JSON.stringify(hooks, null, 2) + "\n");

    const f = detectHindsightRecallTunableDrift("probe", agentConfig(), tmpDir, config());
    expect(f).toHaveLength(1);
    expect(f[0].surface).toBe("memory-tunables");
    expect(f[0].detail).toContain("hook ceiling is 12s, expected 20s");
  });

  it("FAILS when a settings key has been reverted underneath us", () => {
    installHindsightPlugin("probe", tmpDir, config());
    const p = join(tmpDir, ...PLUGIN_REL, "settings.json");
    const s = JSON.parse(readFileSync(p, "utf-8"));
    s.recallRequestTimeoutSeconds = 8;
    writeFileSync(p, JSON.stringify(s, null, 2) + "\n");

    const f = detectHindsightRecallTunableDrift("probe", agentConfig(), tmpDir, config());
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("`recallRequestTimeoutSeconds` is 8, expected 13");
  });

  it("FAILS when a managed key is missing entirely", () => {
    installHindsightPlugin("probe", tmpDir, config());
    const p = join(tmpDir, ...PLUGIN_REL, "settings.json");
    const s = JSON.parse(readFileSync(p, "utf-8"));
    delete s.recallParallelDeadlineSeconds;
    writeFileSync(p, JSON.stringify(s, null, 2) + "\n");

    const f = detectHindsightRecallTunableDrift("probe", agentConfig(), tmpDir, config());
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("missing `recallParallelDeadlineSeconds`");
  });

  it("reports a clamp so an unreachable configured value is not silently ignored", () => {
    const bad = { hook_timeout_seconds: 10, parallel_deadline_seconds: 30 };
    const cfg = configFor(bad);
    installHindsightPlugin("probe", tmpDir, cfg);
    const f = detectHindsightRecallTunableDrift(
      "probe",
      { memory: { recall: bad } } as unknown as AgentConfig,
      tmpDir,
      cfg,
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("clamped");
  });

  it("says nothing for an agent with no plugin installed", () => {
    const f = detectHindsightRecallTunableDrift("probe", agentConfig(), tmpDir, config());
    expect(f).toEqual([]);
  });

  it("is silent when the envelope is set at the `defaults:` tier, not on the agent", () => {
    // doctor-drift.ts:100 passes the RAW `config.agents[name]`, while the
    // installer stamps from the CASCADED config. If this row forgets to
    // cascade, a fleet that tunes recall once under `defaults:` — the natural
    // place to put it — sees a hard FAIL on every single agent, on a plugin
    // that is in fact correctly stamped. That false positive would teach
    // operators to ignore the one row built to catch a real revert.
    const cfg = {
      defaults: { memory: { recall } },
      agents: { probe: {} },
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram: { bot_token: "t", forum_chat_id: "c" },
    } as unknown as SwitchroomConfig;

    installHindsightPlugin("probe", tmpDir, cfg);
    // The installer must genuinely honour the defaults tier, or this test
    // would pass for the wrong reason (both sides agreeing on 12/10/8).
    expect(readFileSync(join(tmpDir, ...PLUGIN_REL, "settings.json"), "utf-8")).toContain(
      '"recallRequestTimeoutSeconds": 13',
    );

    const f = detectHindsightRecallTunableDrift(
      "probe",
      {} as unknown as AgentConfig,
      tmpDir,
      cfg,
    );
    expect(f).toEqual([]);
  });
});

describe("resolveHindsightRecallTunables", () => {
  it("defaults match the literals the plugin shipped before promotion", () => {
    const t = resolveHindsightRecallTunables(undefined);
    expect(t.hookTimeoutSeconds).toBe(DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS);
    expect(t.requestTimeoutSeconds).toBe(DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS);
    expect(t.parallelDeadlineSeconds).toBe(
      DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS - RECALL_DEADLINE_HEADROOM_SECONDS,
    );
    expect(t.clamps).toEqual([]);
  });

  it("derives the deadline from the hook ceiling so raising one raises both", () => {
    expect(resolveHindsightRecallTunables({ hook_timeout_seconds: 30 })
      .parallelDeadlineSeconds).toBe(28);
  });

  it("clamps a deadline that exceeds the hook ceiling (it could never fire)", () => {
    const t = resolveHindsightRecallTunables({
      hook_timeout_seconds: 12,
      parallel_deadline_seconds: 40,
    });
    expect(t.parallelDeadlineSeconds).toBe(12);
    expect(t.clamps.join(" ")).toContain("parallel_deadline_seconds");
  });

  it("clamps a per-bank timeout that exceeds the shared deadline", () => {
    const t = resolveHindsightRecallTunables({
      hook_timeout_seconds: 12,
      request_timeout_seconds: 99,
    });
    expect(t.requestTimeoutSeconds).toBe(10);
    expect(t.clamps.join(" ")).toContain("request_timeout_seconds");
  });

  it("always yields a usable nesting: request <= deadline <= ceiling", () => {
    const cases = [
      { hook_timeout_seconds: 1 },
      { hook_timeout_seconds: 5, parallel_deadline_seconds: 99, request_timeout_seconds: 99 },
      { request_timeout_seconds: 60 },
      { hook_timeout_seconds: 3, request_timeout_seconds: 2 },
    ];
    for (const c of cases) {
      const t = resolveHindsightRecallTunables(c);
      expect(t.requestTimeoutSeconds).toBeLessThanOrEqual(t.parallelDeadlineSeconds);
      expect(t.parallelDeadlineSeconds).toBeLessThanOrEqual(t.hookTimeoutSeconds);
      expect(t.requestTimeoutSeconds).toBeGreaterThan(0);
    }
  });

  it("falls back to shipped defaults on unusable input rather than throwing", () => {
    for (const bad of [
      { hook_timeout_seconds: 0 },
      { hook_timeout_seconds: -5 },
      { hook_timeout_seconds: Number.NaN },
      { hook_timeout_seconds: undefined },
    ]) {
      expect(resolveHindsightRecallTunables(bad).hookTimeoutSeconds).toBe(
        DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS,
      );
    }
  });
});

describe("renderHindsightHooksOverrides", () => {
  const tunables = resolveHindsightRecallTunables({ hook_timeout_seconds: 25 });

  it("touches only the recall hook, leaving sibling hook timeouts alone", () => {
    const raw = readFileSync(
      join(process.cwd(), "vendor", "hindsight-memory", "hooks", "hooks.json"),
      "utf-8",
    );
    const before = JSON.parse(raw);
    const after = JSON.parse(renderHindsightHooksOverrides(raw, tunables)!);

    expect(readHooksRecallTimeout(JSON.stringify(after))).toBe(25);
    // Every other event's hooks must be byte-identical.
    for (const evt of Object.keys(before.hooks)) {
      if (evt === "UserPromptSubmit") continue;
      expect(after.hooks[evt]).toEqual(before.hooks[evt]);
    }
  });

  it("returns null on malformed JSON rather than corrupting the file", () => {
    expect(renderHindsightHooksOverrides("{not json", tunables)).toBeNull();
  });

  it("returns null when no recall hook is present, rather than claiming a stamp", () => {
    // Guards a vendor bump that renames recall.py: silently reporting success
    // would leave the ceiling unmanaged with nothing to notice it.
    const noRecall = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ command: "python3 other.py", timeout: 3 }] }] },
    });
    expect(renderHindsightHooksOverrides(noRecall, tunables)).toBeNull();
  });
});
