/**
 * Regression: switchroom #4607 — the cron-only reconcile WROTE the
 * non-cron scaffold files it was asked not to touch, and only then
 * rejected its own writes.
 *
 * `reconcileAgentCronOnly` (`src/cli/reconcile-bridge.ts`) ran the full
 * `reconcileAgent` with only `skipProfileTemplates: true`, then post-hoc
 * filtered `result.changes` through `classifyChangeKind` and returned
 * `E_RECONCILE_FAILED` for anything not classified `"cron"`. The scaffold
 * writers had no gate, so `.claude/agents/<sub>.md` and
 * `.claude/settings.json` were already on disk by the time the guard ran:
 * the first `schedule_add` / `schedule_remove` after any scaffold drift
 * failed AFTER committing both the overlay delete and the scaffold
 * rewrite, and the retry succeeded only because the writers are
 * content-gated (second render = no-op).
 *
 * The fix is a real opt-out — `ReconcileOptions.skipNonCronWrites` —
 * which suppresses every writer whose path `classifyChangeKind` does not
 * call `"cron"`.
 *
 * These tests deliberately assert BOTH halves for each gated writer:
 *   (1) the reconcile succeeds / reports no non-cron change, and
 *   (2) the drifted file on disk is byte-identical to how it started.
 * A test that only checked (1) would pass on the buggy code once the
 * guard was removed, while the writes still landed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import { classifyChangeKind } from "../src/agents/lifecycle.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const switchroomConfig: SwitchroomConfig = {
  agents: {},
  telegram: telegramConfig,
  defaults: {},
};

function makeAgentConfig(): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    subagents: {
      worker: {
        description: "Implements a task",
        prompt: "You are the worker sub-agent.",
      },
    },
  } as unknown as AgentConfig;
}

/** The option pair the in-container cron bridge passes. */
const CRON_ONLY = { skipProfileTemplates: true, skipNonCronWrites: true } as const;

describe("reconcileAgent — skipNonCronWrites (#4607)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-skip-non-cron-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drifted sub-agent md + settings.json: cron-only reconcile succeeds AND leaves both byte-identical", () => {
    const name = "alpha";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const subAgentPath = join(tmpDir, name, ".claude", "agents", "worker.md");
    const settingsPath = join(tmpDir, name, ".claude", "settings.json");
    expect(existsSync(subAgentPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    // Drift both away from what the current template renders — the exact
    // precondition from the issue (an agent whose scaffold predates the
    // current subagent/settings render).
    const driftedSubAgent =
      readFileSync(subAgentPath, "utf-8") + "\n<!-- stale render from an older template -->\n";
    writeFileSync(subAgentPath, driftedSubAgent, "utf-8");

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.permissions = settings.permissions ?? {};
    settings.permissions.allow = ["Read(//stale/**)"];
    const driftedSettings = JSON.stringify(settings, null, 2) + "\n";
    writeFileSync(settingsPath, driftedSettings, "utf-8");

    // Cron-only reconcile.
    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      CRON_ONLY,
    );

    // (1) Nothing was written. Asserted FIRST because it is the load-
    //     bearing half: on the bug the drifted bytes were replaced by a
    //     fresh render, and this assertion still fails even if someone
    //     "fixes" the symptom by deleting the bridge's guard.
    expect(readFileSync(subAgentPath, "utf-8")).toBe(driftedSubAgent);
    expect(readFileSync(settingsPath, "utf-8")).toBe(driftedSettings);

    // (2) And no non-cron change is reported — this is the list the
    //     bridge's guard turns into E_RECONCILE_FAILED.
    const nonCron = result.changes.filter((p) => classifyChangeKind(p) !== "cron");
    expect(nonCron).toEqual([]);
  });

  it("drifted .mcp.json: cron-only reconcile leaves it byte-identical", () => {
    const name = "beta";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const mcpJsonPath = join(tmpDir, name, ".mcp.json");
    expect(existsSync(mcpJsonPath)).toBe(true);
    const drifted = JSON.stringify({ mcpServers: { stale: { command: "true" } } }, null, 2) + "\n";
    writeFileSync(mcpJsonPath, drifted, "utf-8");

    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      CRON_ONLY,
    );

    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);
    expect(readFileSync(mcpJsonPath, "utf-8")).toBe(drifted);
  });

  it("missing SOUL.md symlink: cron-only reconcile does not perform the migration", () => {
    const name = "gamma";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const agentSoulPath = join(tmpDir, name, "SOUL.md");
    const workspaceSoulPath = join(tmpDir, name, "workspace", "SOUL.md");
    expect(existsSync(workspaceSoulPath)).toBe(true);
    // Replace the symlink with a plain file — the state the migration
    // block rewrites (and reports as a non-cron change).
    if (existsSync(agentSoulPath) || lstatSyncSafe(agentSoulPath)) {
      rmSync(agentSoulPath, { force: true });
    }
    writeFileSync(agentSoulPath, "# hand-written soul\n", "utf-8");

    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      CRON_ONLY,
    );

    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);
    expect(lstatSync(agentSoulPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(agentSoulPath, "utf-8")).toBe("# hand-written soul\n");
  });

  it("default options still write the scaffold surfaces (the gate is honest, not a global mute)", () => {
    const name = "delta";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const subAgentPath = join(tmpDir, name, ".claude", "agents", "worker.md");
    const settingsPath = join(tmpDir, name, ".claude", "settings.json");
    writeFileSync(subAgentPath, "# stale\n", "utf-8");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.permissions = { allow: ["Read(//stale/**)"], deny: [] };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      {},
    );

    expect(result.changes).toContain(subAgentPath);
    expect(result.changes).toContain(settingsPath);
    expect(readFileSync(subAgentPath, "utf-8")).not.toBe("# stale\n");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow).not.toEqual([
      "Read(//stale/**)",
    ]);
  });

  it("cron-only reconcile still sweeps stale cron scripts (cron writes are NOT suppressed)", () => {
    const name = "epsilon";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    // A retired cron wrapper script + sidecar, the one thing the cron-only
    // path is still allowed (and expected) to remove.
    const telegramDir = join(tmpDir, name, "telegram");
    const staleScript = join(telegramDir, "cron-0123456789ab.sh");
    const staleSidecar = join(telegramDir, "cron-0123456789ab.source");
    writeFileSync(staleScript, "#!/bin/sh\n", "utf-8");
    writeFileSync(staleSidecar, "stale\n", "utf-8");

    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      CRON_ONLY,
    );

    expect(result.changes).toContain(staleScript);
    expect(existsSync(staleScript)).toBe(false);
    expect(existsSync(staleSidecar)).toBe(false);
    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);
  });
});

/** lstat that tolerates a broken symlink / absent path. */
function lstatSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
