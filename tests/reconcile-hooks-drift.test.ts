import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { buildSettingsHooksBlock, detectHooksDrift } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig } from "../src/config/schema.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("buildSettingsHooksBlock", () => {
  it("with no user hooks returns only switchroom-owned hooks", () => {
    const agentConfig = makeAgentConfig();
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    // Must have UserPromptSubmit (always present)
    expect(result.UserPromptSubmit).toBeDefined();
    expect(Array.isArray(result.UserPromptSubmit)).toBe(true);

    // workspace-dynamic and timezone hooks must be present
    const ups = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = ups.flatMap(entry => entry.hooks.map(h => h.command));
    expect(commands.some(c => c.includes("workspace-dynamic-hook.sh"))).toBe(true);
    expect(commands.some(c => c.includes("timezone-hook.sh"))).toBe(true);

    // Without telegram plugin: no PreToolUse or PostToolUse
    expect(result.PreToolUse).toBeUndefined();
    expect(result.PostToolUse).toBeUndefined();
  });

  it("wires the working-state-reload SessionStart hook scoped to matcher 'compact'", () => {
    // The working-state file is re-injected into context after compaction via
    // a SessionStart hook. matcher "compact" is load-bearing: it scopes the
    // hook to compaction ONLY, so the file is NOT re-injected on every
    // startup/resume/clear/fork boot. SessionStart stdout is added to the
    // model's context by Claude Code (unlike PreCompact). Default for every
    // agent — present with or without the telegram plugin.
    for (const useSwitchroomPlugin of [false, true]) {
      const result = buildSettingsHooksBlock({
        agentName: "test-agent",
        agentConfig: makeAgentConfig(),
        hindsightEnabled: false,
        useSwitchroomPlugin,
      });
      const sessionStart = (result.SessionStart ?? []) as Array<{
        matcher?: string;
        hooks: Array<{ command: string; timeout?: number }>;
      }>;
      const reloadEntry = sessionStart.find((e) =>
        e.hooks.some((h) => h.command.includes("working-state-reload-hook.sh")),
      );
      expect(reloadEntry, `plugin=${useSwitchroomPlugin}`).toBeDefined();
      // MUST carry matcher "compact" — a bare/absent matcher would fire on
      // every SessionStart source and re-inject working state on every boot.
      expect(reloadEntry?.matcher).toBe("compact");
      // Timeout MUST leave headroom for the lean-briefing network hop (P1):
      // the hook shells out to handoff-briefing.sh --lean, whose Hindsight
      // recall is capped at ~3s. A 3s hook timeout (the pre-P1 value) would
      // race that cap; 8s is the intended budget.
      const reloadHook = reloadEntry?.hooks.find((h) =>
        h.command.includes("working-state-reload-hook.sh"),
      );
      expect(reloadHook?.timeout).toBe(8);
    }
  });

  it("emits the recovery block on source=compact even with NO working-state file", () => {
    // The unconditional post-compaction recovery/orientation block is the
    // load-bearing default: it must fire for EVERY agent, whether or not it
    // maintains a working-state file. Invoke the real hook script with
    // {"source":"compact"} on stdin and an empty state dir (no
    // .working-state.md) and assert the <compact-recovery> delimiter is
    // present on stdout.
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const emptyStateDir = mkdtempSync(join(tmpdir(), "ws-recovery-"));
    try {
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"compact"}',
        encoding: "utf8",
        env: { ...process.env, TELEGRAM_STATE_DIR: emptyStateDir },
      });
      // Recovery block emitted despite the absent working-state file.
      expect(stdout).toContain("<compact-recovery");
      // And no working-state append, since the file is absent.
      expect(stdout).not.toContain("<working-state");
    } finally {
      rmSync(emptyStateDir, { recursive: true, force: true });
    }
  });

  it("emits NOTHING on a non-compact source (e.g. startup)", () => {
    // The source guard scopes the hook to compaction only; a startup boot
    // must be a silent no-op even when a working-state file exists.
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "ws-startup-"));
    try {
      writeFileSync(join(stateDir, ".working-state.md"), "should not appear\n");
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"startup"}',
        encoding: "utf8",
        env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
      });
      expect(stdout).toBe("");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // ── P1: lean post-compaction briefing ─────────────────────────────────────
  // The hook, on source=compact, additionally emits a LEAN briefing (recent
  // Telegram tail + Hindsight recall) assembled by handoff-briefing.sh --lean,
  // giving a compacted session fresh-boot parity. These tests drive the REAL
  // hook + assembler against a fixture history.db.

  // Build a fixture history.db with two chat surfaces: an OLDER "stale pending"
  // chat and a NEWER "db-latest" chat. Uses python3 (the same dependency the
  // hook's assembler already requires) so the fixture matches the real schema.
  function makeHistoryDb(dir: string): void {
    const script = `
import sqlite3, sys, time
db = sys.argv[1]
c = sqlite3.connect(db)
c.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, role TEXT, user TEXT, "
          "ts INTEGER, text TEXT, chat_id TEXT, thread_id INTEGER, "
          "reply_to_message_id INTEGER, reply_to_text TEXT)")
now = int(time.time())
rows = [
  ('user', 'alice', now - 9000, 'STALE_PENDING_MARKER old chat', '1111', None, None, None),
  ('assistant', None, now - 8990, 'stale reply', '1111', None, None, None),
  ('user', 'bob', now - 120, 'LATEST_DB_MARKER active chat', '2222', None, None, None),
  ('assistant', None, now - 110, 'latest reply', '2222', None, None, None),
]
c.executemany("INSERT INTO messages(role,user,ts,text,chat_id,thread_id,"
              "reply_to_message_id,reply_to_text) VALUES(?,?,?,?,?,?,?,?)", rows)
c.commit(); c.close()
`;
    execFileSync("python3", ["-c", script, join(dir, "history.db")], {
      encoding: "utf8",
    });
  }

  // Env that isolates the assembler to the Telegram section only: no Hindsight
  // (empty URL/bank → recall skipped), deterministic output. The caller sets
  // SWITCHROOM_PENDING_CHAT_ID to the stale surface to exercise the db-latest
  // override.
  //
  // Hermeticity: the tests run inside an agent container whose process.env may
  // already carry SWITCHROOM_PENDING_* (the pending-turn scope) or
  // HANDOFF_BRIEFING_* tunables. Those would silently change the assembler's
  // scoping/limit and flake the startup/degrade assertions, so null them here
  // and let each test opt back in via `extra`.
  function hookEnv(stateDir: string, extra: Record<string, string> = {}) {
    return {
      ...process.env,
      TELEGRAM_STATE_DIR: stateDir,
      HINDSIGHT_API_URL: "",
      HINDSIGHT_BANK_ID: "",
      SWITCHROOM_PENDING_CHAT_ID: "",
      SWITCHROOM_PENDING_THREAD_ID: "",
      SWITCHROOM_PENDING_ENDED_VIA: "",
      HANDOFF_BRIEFING_MAX_MESSAGES: "",
      HANDOFF_BRIEFING_STDOUT: "",
      HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT: "",
      ...extra,
    };
  }

  it("emits the lean <compact-briefing> on source=compact and follows db-latest, NOT the stale SWITCHROOM_PENDING_* surface", () => {
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "ws-lean-"));
    try {
      makeHistoryDb(stateDir);
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"compact"}',
        encoding: "utf8",
        // Stale pending scope points at chat 1111; the lean path must IGNORE it
        // and brief the db-latest surface (chat 2222) instead.
        env: hookEnv(stateDir, {
          SWITCHROOM_PENDING_CHAT_ID: "1111",
          SWITCHROOM_PENDING_THREAD_ID: "NULL",
        }),
      });
      // The recovery block still leads, then the lean briefing.
      expect(stdout).toContain("<compact-recovery");
      expect(stdout).toContain("<compact-briefing");
      // db-latest surface content is present…
      expect(stdout).toContain("LATEST_DB_MARKER");
      // …and the stale pending surface's content is NOT — proving the compaction
      // path derived latest-from-db rather than honouring the stale env scope.
      expect(stdout).not.toContain("STALE_PENDING_MARKER");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("emits NO lean briefing on source=startup, even with a populated history.db", () => {
    // The source guard scopes the whole hook (recovery block AND lean briefing)
    // to compaction only. A startup boot with real history must stay silent.
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "ws-lean-startup-"));
    try {
      makeHistoryDb(stateDir);
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"startup"}',
        encoding: "utf8",
        env: hookEnv(stateDir),
      });
      expect(stdout).toBe("");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("degrades gracefully on source=compact when history.db is absent (recovery block only, exit 0)", () => {
    // No history.db and no Hindsight → the lean briefing has nothing to emit.
    // The hook must still print the recovery block and exit 0 (never fail).
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "ws-lean-empty-"));
    try {
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"compact"}',
        encoding: "utf8",
        env: hookEnv(stateDir),
      });
      expect(stdout).toContain("<compact-recovery");
      // No DB, no Hindsight → the lean briefing block is omitted entirely.
      expect(stdout).not.toContain("<compact-briefing");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the #4390 recovery block when the assembler runs long (inner timeout degrades to recovery-only)", () => {
    // Low 1: the assembler is capped by an inner `timeout` SHORTER than the 8s
    // Claude Code hook budget, so a slow assembler (e.g. an operator raising
    // HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT past the budget) degrades to "recovery
    // block only" instead of Claude Code killing the WHOLE hook and discarding
    // every byte of stdout — including the near-unkillable <compact-recovery>
    // orientation block. Point Hindsight at a black-hole (TEST-NET-1, RFC 5737)
    // with a long recall timeout; the inner cap must fire and the recovery
    // block must survive.
    const hookPath = fileURLToPath(
      new URL("../bin/working-state-reload-hook.sh", import.meta.url),
    );
    const stateDir = mkdtempSync(join(tmpdir(), "ws-lean-slow-"));
    try {
      makeHistoryDb(stateDir);
      const started = Date.now();
      const stdout = execFileSync("bash", [hookPath], {
        input: '{"source":"compact"}',
        encoding: "utf8",
        env: hookEnv(stateDir, {
          // Black-hole endpoint → curl hangs; a 30s recall timeout would blow
          // past the 8s hook budget if the inner `timeout` did not cap it.
          HINDSIGHT_API_URL: "http://192.0.2.1:9/x",
          HINDSIGHT_BANK_ID: "bank",
          HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT: "30",
        }),
      });
      const elapsedMs = Date.now() - started;
      // Recovery floor intact despite the slow assembler.
      expect(stdout).toContain("<compact-recovery");
      // The slow assembler was killed by the inner cap → no lean briefing.
      expect(stdout).not.toContain("<compact-briefing");
      // Inner cap (5s) fired well before the 8s hook budget and the 30s recall.
      expect(elapsedMs).toBeLessThan(8000);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15000);

  it("does NOT wire the retired user-profile-refresh Stop hook, even with hindsight enabled", () => {
    // Per-agent user-profile mental models are retired in favour of dedicated
    // profile banks — the refresh Stop hook must no longer be emitted.
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig(),
      hindsightEnabled: true,
      useSwitchroomPlugin: true,
    });
    const stop = (result.Stop ?? []) as Array<{ hooks: Array<{ command: string }> }>;
    const stopCmds = stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopCmds.some((c) => c.includes("user-profile-refresh-hook.sh"))).toBe(false);
  });

  it("wires the agent self-improvement Stop gate when the telegram plugin is on", () => {
    // RFC reference/rfcs/agent-self-improvement.md slice 1: the turn-end
    // gate attaches as a switchroom-owned async Stop hook, alongside
    // handoff / secret-scrub / tool-label. Gated on useSwitchroomPlugin
    // because it needs the gateway socket to inject the forked review.
    const withPlugin = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig(),
      hindsightEnabled: false,
      useSwitchroomPlugin: true,
    });
    const stopWith = (withPlugin.Stop ?? []) as Array<{
      hooks: Array<{ command: string; async?: boolean }>;
    }>;
    const selfImprove = stopWith
      .flatMap((e) => e.hooks)
      .find((h) => h.command.includes("self-improve-stop.mjs"));
    expect(selfImprove).toBeDefined();
    expect(selfImprove?.async).toBe(true);

    // Without the plugin, no gateway socket → the gate is not wired.
    const noPlugin = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig(),
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });
    const stopNo = (noPlugin.Stop ?? []) as Array<{ hooks: Array<{ command: string }> }>;
    const stopNoCmds = stopNo.flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopNoCmds.some((c) => c.includes("self-improve-stop.mjs"))).toBe(false);
  });

  it("with telegram plugin adds PreToolUse and PostToolUse hooks", () => {
    const agentConfig = makeAgentConfig({
      plugin: "switchroom-telegram",
    });
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: true,
    });

    expect(result.PreToolUse).toBeDefined();
    expect(Array.isArray(result.PreToolUse)).toBe(true);
    const preHooks = result.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const preCmds = preHooks.flatMap(e => e.hooks.map(h => h.command));
    expect(preCmds.some(c => c.includes("secret-guard-pretool.mjs"))).toBe(true);
    expect(preCmds.some(c => c.includes("subagent-tracker-pretool.mjs"))).toBe(true);

    // secret-guard must run on every tool (no matcher); subagent-tracker must
    // be scoped to the Agent tool so it doesn't fire ~120ms/turn for nothing.
    const secretGuardEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("secret-guard-pretool.mjs")),
    );
    expect(secretGuardEntry?.matcher).toBeUndefined();
    const subagentPreEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("subagent-tracker-pretool.mjs")),
    );
    expect(subagentPreEntry?.matcher).toBe("^(Agent|Task)$");

    expect(result.PostToolUse).toBeDefined();
    const postHooks = result.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const postCmds = postHooks.flatMap(e => e.hooks.map(h => h.command));
    expect(postCmds.some(c => c.includes("subagent-tracker-posttool.mjs"))).toBe(true);
    const subagentPostEntry = postHooks.find(e =>
      e.hooks.some(h => h.command.includes("subagent-tracker-posttool.mjs")),
    );
    expect(subagentPostEntry?.matcher).toBe("^(Agent|Task)$");

    // PR #1811 / v0.13.48: repo-context-pretool must be registered AND
    // matched to the file-touching + Bash tools. Drift between the
    // scaffold list (here) and telegram-plugin/hooks/hooks.json silently
    // skips the hook — the live UAT for #1811 caught exactly this gap on
    // v0.13.48 before the v0.13.49 hotfix landed.
    expect(preCmds.some(c => c.includes("repo-context-pretool.mjs"))).toBe(true);
    const repoContextEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("repo-context-pretool.mjs")),
    );
    expect(repoContextEntry?.matcher).toBe("^(Read|Edit|Write|MultiEdit|NotebookEdit|Bash)$");

    // RFC agent-self-improvement slice 2: the deterministic apply-guard
    // PreToolUse hook is registered and scoped to the file-write tools (it
    // no-ops unless a self-improve review marker is present).
    expect(preCmds.some(c => c.includes("self-improve-apply-guard-pretool.mjs"))).toBe(true);
    const applyGuardEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("self-improve-apply-guard-pretool.mjs")),
    );
    expect(applyGuardEntry?.matcher).toBe("^(Write|Edit|MultiEdit)$");

    // #2974: the mental-model write redirect PreToolUse hook is registered
    // and scoped to hindsight tools; it denies the four write tools and
    // passes reads through.
    expect(preCmds.some(c => c.includes("hindsight-mental-model-pretool.mjs"))).toBe(true);
    const mmEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("hindsight-mental-model-pretool.mjs")),
    );
    expect(mmEntry?.matcher).toBe("^mcp__hindsight__");

    // Foreground turn-hog gate: registered and scoped to Bash; it denies
    // effectively-unbounded foreground shapes (tail -f, watch, sleep > 30s,
    // sleep-loops, gh --watch, log followers) with an instructive
    // "re-run with run_in_background: true" message.
    expect(preCmds.some(c => c.includes("foreground-hog-pretool.mjs"))).toBe(true);
    const fgHogEntry = preHooks.find(e =>
      e.hooks.some(h => h.command.includes("foreground-hog-pretool.mjs")),
    );
    expect(fgHogEntry?.matcher).toBe("^Bash$");
  });

  it("with user hooks declared merges them with switchroom-owned hooks", () => {
    const agentConfig = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [
          { type: "command", command: "echo user-hook" },
        ],
      },
    });

    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    const ups = result.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = ups.flatMap(entry => entry.hooks.map(h => h.command));

    // User hook must appear
    expect(commands.some(c => c.includes("echo user-hook"))).toBe(true);
    // Switchroom-owned hooks must also appear
    expect(commands.some(c => c.includes("workspace-dynamic-hook.sh"))).toBe(true);
    expect(commands.some(c => c.includes("timezone-hook.sh"))).toBe(true);
  });

  it("is idempotent — calling twice with same input produces deeply equal output", () => {
    const agentConfig = makeAgentConfig({
      plugin: "switchroom-telegram",
      hooks: {
        Stop: [{ type: "command", command: "echo my-stop" }],
      },
    });
    const params = {
      agentName: "idempotent-agent",
      agentConfig,
      hindsightEnabled: true,
      useSwitchroomPlugin: true,
    };

    const first = buildSettingsHooksBlock(params);
    const second = buildSettingsHooksBlock(params);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("never bakes --config into the handoff command, even when configPath is passed (#1745 supersedes #1079)", () => {
    const agentConfig = makeAgentConfig();
    const hostConfigPath = "/home/user/switchroom.yaml";
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
      configPath: hostConfigPath,
    });

    const stop = result.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
    expect(stop).toBeDefined();
    const stopCmds = (stop ?? []).flatMap(e => e.hooks.map(h => h.command));
    const handoffCmd = stopCmds.find(c => c.includes("handoff"));
    expect(handoffCmd).toBeDefined();
    // Pre-#1745 the hook baked `--config /state/config/switchroom.yaml`
    // into the command so the CLI could find the yaml inside the
    // container. But the yaml isn't bind-mounted into sandboxed
    // agents, so loadConfig() threw ConfigError on every Stop. The
    // handoff CLI now treats config-load as non-fatal, so the
    // `--config` arg is no longer needed and is no longer emitted —
    // even if a host-side caller passes `configPath`.
    expect(handoffCmd).not.toContain("--config");
    expect(handoffCmd).not.toContain(hostConfigPath);
    expect(handoffCmd).not.toContain("/state/config/switchroom.yaml");
  });

  it("handoff command has no --config flag when configPath is omitted", () => {
    const agentConfig = makeAgentConfig();
    const result = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    const stop = result.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
    expect(stop).toBeDefined();
    const stopCmds = (stop ?? []).flatMap(e => e.hooks.map(h => h.command));
    const handoffCmd = stopCmds.find(c => c.includes("handoff"));
    expect(handoffCmd).toBeDefined();
    expect(handoffCmd).not.toContain("--config");
  });
});

describe("inject_on_change command format drift detection", () => {
  it("new env-prefix turn-pacing command is not-drift vs itself", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    const params = {
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    };
    const expected = buildSettingsHooksBlock(params);
    const { drifted } = detectHooksDrift(expected, expected);
    expect(drifted).toBe(false);
  });

  it("old printf-style turn-pacing command is detected as drift vs new env-prefix form", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    // Build the current (correct) hooks block.
    const expected = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });

    // Simulate a stale settings.json that still has the old printf-style command.
    // We deep-clone expected and replace the turn-pacing command with the old format.
    const stale = JSON.parse(JSON.stringify(expected)) as typeof expected;
    const ups = stale.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    for (const entry of ups) {
      for (const hook of entry.hooks) {
        if (hook.command.includes("turn-pacing-hook.sh")) {
          // Replace with old-style printf form (no env prefix).
          hook.command = hook.command.replace(
            /^bash run-hook\.sh 'hook:turn-pacing' env /,
            "bash run-hook.sh 'hook:turn-pacing' ",
          );
          // Also simulate the really old format with bare assignment.
          hook.command = "bash run-hook.sh 'hook:turn-pacing' TURN_PACING_DIRECTIVE='old directive' bash \"/opt/switchroom/bin/turn-pacing-hook.sh\"";
        }
      }
    }

    const { drifted } = detectHooksDrift(expected, stale as Record<string, unknown>);
    expect(drifted).toBe(true);
  });

  it("default workspace-dynamic command carries no inject-on-change env and is not-drift vs itself", () => {
    // inject-on-change is the unconditional hook default now, so the
    // scaffolded command threads no SWITCHROOM_INJECT_ON_CHANGE env.
    const agentConfig = makeAgentConfig({
      channels: { telegram: { inject_on_change: true } },
    });
    const params = {
      agentName: "test-agent",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    };
    const expected = buildSettingsHooksBlock(params);
    const ups = expected.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const wsDynCmd = ups.flatMap(e => e.hooks.map(h => h.command))
      .find(c => c.includes("workspace-dynamic-hook.sh"));
    expect(wsDynCmd).toBeDefined();
    expect(wsDynCmd).not.toContain("SWITCHROOM_INJECT_ON_CHANGE");
    // And it must not-drift vs itself.
    const { drifted } = detectHooksDrift(expected, expected);
    expect(drifted).toBe(false);
  });

  it("opt-out (inject_on_change=false) threads env=0 and drifts vs the default form", () => {
    const optOut = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig({
        channels: { telegram: { inject_on_change: false } },
      }),
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });
    const ups = optOut.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const wsDynCmd = ups.flatMap(e => e.hooks.map(h => h.command))
      .find(c => c.includes("workspace-dynamic-hook.sh"));
    expect(wsDynCmd).toBeDefined();
    expect(wsDynCmd).toContain("env SWITCHROOM_INJECT_ON_CHANGE=0");

    // Default (no opt-out) form is the drift baseline: the opt-out command
    // differs, so drift detection must fire against it.
    const dflt = buildSettingsHooksBlock({
      agentName: "test-agent",
      agentConfig: makeAgentConfig({
        channels: { telegram: { inject_on_change: true } },
      }),
      hindsightEnabled: false,
      useSwitchroomPlugin: false,
    });
    const { drifted } = detectHooksDrift(dflt, optOut as Record<string, unknown>);
    expect(drifted).toBe(true);
  });
});

describe("detectHooksDrift", () => {
  it("returns drifted=false when hooks are identical", () => {
    const hooks = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
    };
    const result = detectHooksDrift(hooks, hooks);
    expect(result.drifted).toBe(false);
    expect(result.summary).toBe("in sync");
  });

  it("returns drifted=false when hooks are equal but key order differs", () => {
    const expected = { UserPromptSubmit: [{ hooks: [{ timeout: 5, command: "echo hi", type: "command" }] }] };
    const actual   = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }] };
    const result = detectHooksDrift(expected, actual);
    expect(result.drifted).toBe(false);
  });

  it("returns drifted=true when hooks differ", () => {
    const expected = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo new", timeout: 5 }] }] };
    const actual   = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo old", timeout: 5 }] }] };
    const result = detectHooksDrift(expected, actual);
    expect(result.drifted).toBe(true);
    expect(result.summary).toContain("DRIFTED");
    expect(result.summary).toContain("UserPromptSubmit");
  });

  it("drift fixture: stale settings.json detected as drifted", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "switchroom-drift-test-"));
    try {
      const claudeDir = join(tmpDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, "settings.json");

      // Write a stale settings.json with an outdated hooks block
      const staleSettings = {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo stale-hook", timeout: 5 }] },
          ],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(staleSettings, null, 2), "utf-8");
      expect(existsSync(settingsPath)).toBe(true);

      // Compute what the current config would produce
      const agentConfig = makeAgentConfig();
      const expected = buildSettingsHooksBlock({
        agentName: "my-agent",
        agentConfig,
        hindsightEnabled: false,
        useSwitchroomPlugin: false,
      });

      const actual = (staleSettings.hooks as Record<string, unknown>);
      const { drifted, summary } = detectHooksDrift(expected, actual);
      expect(drifted).toBe(true);
      expect(summary).toContain("DRIFTED");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
