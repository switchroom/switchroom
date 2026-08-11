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
 * which suppresses the known writers whose paths `classifyChangeKind`
 * does not call `"cron"`. Its load-bearing guarantee is scoped to the
 * `changes.push` audit behind #4607 (no non-cron write can reach
 * `result.changes`), not to "this process performs no non-cron file IO";
 * see the option's doc-comment in `src/agents/scaffold.ts`.
 *
 * These tests deliberately assert BOTH halves for each gated writer, and
 * always in this order:
 *   (1) the drifted file on disk is byte-identical to how it started, and
 *   (2) the reconcile reports no non-cron change.
 * Disk state comes FIRST in every drift case on purpose: it is the half a
 * guard-only "fix" would not catch (a test that only checked (2) passes on
 * the buggy code the moment the bridge's guard is deleted, while the writes
 * still land), and for the two writers that never reach `changes` at all —
 * `syncGlobalSkills`, `ensureMcpServersTrusted` — it is the ONLY half that
 * can assert anything.
 *
 * Cases whose writer never surfaces in `changes` carry an in-test positive
 * control: the same fixture re-reconciled with the gate off, proving the
 * writer is genuinely reachable and the gated assertion is not vacuous.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
  mkdirSync,
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

    // Disk state first — see case 1.
    expect(readFileSync(mcpJsonPath, "utf-8")).toBe(drifted);
    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);
  });

  it("placeholder telegram/.env: cron-only reconcile does NOT perform the bot-token refresh", () => {
    // The scenario from #4607's review: an agent scaffolded while its
    // `bot_token` was an unresolvable `vault:` reference froze the
    // placeholder into `telegram/.env`; the operator later runs
    // `vault set`, and the agent's next `schedule_add` would have
    // silently rewritten `.env` (classified "other") as a side effect.
    // A schedule change never implies a bot-token repair — that is the
    // host reconcile's job.
    const name = "zeta";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const envPath = join(tmpDir, name, "telegram", ".env");
    expect(existsSync(envPath)).toBe(true);
    // Put the file back into the state a vault-unresolvable scaffold
    // leaves behind: no active TELEGRAM_BOT_TOKEN= line.
    const placeholder = "# Set your bot token: TELEGRAM_BOT_TOKEN=your-token-here\n";
    writeFileSync(envPath, placeholder, "utf-8");

    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      CRON_ONLY,
    );

    // Disk state first — see case 1.
    expect(readFileSync(envPath, "utf-8")).toBe(placeholder);
    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);

    // Positive control, in-test: the SAME fixture with the gate off DOES
    // refresh the token. Without this the case could pass vacuously (a
    // fixture that never reaches the writer asserts nothing), and it is
    // what makes the test fail if the gate at scaffold.ts's
    // `refreshTelegramBotTokenEnv` call site is ever dropped — the first
    // assertion above would then see the refreshed body instead of the
    // placeholder.
    const ungated = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      {},
    );
    expect(readFileSync(envPath, "utf-8")).not.toBe(placeholder);
    expect(readFileSync(envPath, "utf-8")).toContain(telegramConfig.bot_token);
    expect(ungated.changes).toContain(envPath);
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

    // Disk state first — see case 1.
    expect(lstatSync(agentSoulPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(agentSoulPath, "utf-8")).toBe("# hand-written soul\n");
    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);
  });

  it("newly declared global skill: cron-only reconcile does NOT sync the .claude/skills/ symlink", () => {
    // `syncGlobalSkills` never pushes to `changes`, so the bridge's guard
    // could never have caught it — it is gated because the contract is
    // "cron only", not "cron only as far as the guard can see". Asserted
    // on disk for exactly that reason.
    const name = "eta";
    const skillsPool = join(tmpDir, "_pool");
    mkdirSync(join(skillsPool, "humanizer"), { recursive: true });
    writeFileSync(join(skillsPool, "humanizer", "SKILL.md"), "# humanizer\n", "utf-8");
    const configWithPool = {
      ...switchroomConfig,
      switchroom: { skills_dir: skillsPool },
    } as unknown as SwitchroomConfig;

    // Scaffold WITHOUT the skill, then reconcile with it declared — the
    // real shape (operator adds `skills:` to switchroom.yaml; the agent's
    // next schedule_add must not be what installs it).
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, configWithPool);
    const linkPath = join(tmpDir, name, ".claude", "skills", "humanizer");
    // lstat, not existsSync: existsSync follows the link, so a BROKEN
    // symlink would read as "absent" and pass this vacuously.
    expect(lstatSyncSafe(linkPath)).toBe(false);

    const withSkill = { ...makeAgentConfig(), skills: ["humanizer"] } as unknown as AgentConfig;
    const result = reconcileAgent(
      name,
      withSkill,
      tmpDir,
      telegramConfig,
      configWithPool,
      undefined,
      CRON_ONLY,
    );

    // Disk state first — see case 1.
    expect(lstatSyncSafe(linkPath)).toBe(false);
    expect(result.changes.filter((p) => classifyChangeKind(p) !== "cron")).toEqual([]);

    // Positive control: same fixture, gate off, the symlink lands. Proves
    // the case is not passing vacuously on an unreachable writer.
    reconcileAgent(name, withSkill, tmpDir, telegramConfig, configWithPool, undefined, {});
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
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
