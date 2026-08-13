import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readlinkSync, lstatSync, readdirSync, cpSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Assert `linkPath` is a switchroom-written pool skill link (footgun A):
 * the stored target is RELATIVE (never absolute — absolute links baked with
 * homedir() dangle across container mount contexts) and resolves, from the
 * link's own directory, to `expectedPoolTarget`.
 */
function expectRelativePoolLink(linkPath: string, expectedPoolTarget: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readlinkSync: rl } = require("node:fs");
  const stored: string = rl(linkPath);
  expect(isAbsolute(stored)).toBe(false);
  expect(resolve(dirname(linkPath), stored)).toBe(resolve(expectedPoolTarget));
}
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { scaffoldAgent, reconcileAgent, installHindsightPlugin, installSwitchroomSkills, renderFleetInvariants, computeDesiredPermissionAllow, HINDSIGHT_RECALL_QUERY_MAX_TOKENS_DEFAULT, HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS_DEFAULT } from "../src/agents/scaffold.js";
import { resolveHindsightRecallTunables } from "../src/setup/hindsight-recall-tunables.js";
import { createVault, setStringSecret } from "../src/vault/vault.js";
import { renderTemplate, renderProfileClaudeTemplate } from "../src/agents/profiles.js";
import { cronScriptFilename, cronUnitName } from "../src/agents/cron-unit-name.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("scaffoldAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the correct directory structure", () => {
    const config = makeAgentConfig({ topic_name: "Health" });
    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".claude"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "CLAUDE.md"))).toBe(true);
    // Phase 2: SOUL.md is now a symlink to workspace/SOUL.md
    expect(existsSync(join(result.agentDir, "SOUL.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "workspace", "SOUL.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", ".env"))).toBe(true);
    expect(existsSync(join(result.agentDir, "telegram", "access.json"))).toBe(true);
    expect(existsSync(join(result.agentDir, "start.sh"))).toBe(true);
  });

  it("seeds a switchroom-owned SOUL.default.md baseline that is RESTORED (not seed-once)", () => {
    const config = makeAgentConfig({});
    const r1 = scaffoldAgent("persona-agent", config, tmpDir, telegramConfig);
    const soulDefault = join(r1.agentDir, "workspace", "SOUL.default.md");
    // Created with the switchroom baseline.
    expect(existsSync(soulDefault)).toBe(true);
    const baseline = readFileSync(soulDefault, "utf-8");
    expect(baseline).toContain("Baseline");
    expect(baseline).toContain("capable teammate");
    expect(baseline).toMatch(/SOUL\.md.*(overrides|precedence|below)/i);

    // switchroom-OWNED: tampering is restored on reconcile (unlike the
    // operator-owned SOUL.md, which is seed-once / never overwritten).
    writeFileSync(soulDefault, "tampered");
    const soulMd = join(r1.agentDir, "workspace", "SOUL.md");
    const operatorPersona = "# My hand-tuned persona\nI am unmistakably custom.";
    writeFileSync(soulMd, operatorPersona);
    scaffoldAgent("persona-agent", config, tmpDir, telegramConfig);
    // Default restored:
    expect(readFileSync(soulDefault, "utf-8")).toContain("capable teammate");
    expect(readFileSync(soulDefault, "utf-8")).not.toBe("tampered");
    // Operator persona preserved (seed-once, never clobbered):
    expect(readFileSync(soulMd, "utf-8")).toBe(operatorPersona);
  });

  it("composes SOUL.default before the operator SOUL in the stable bootstrap", async () => {
    const { STABLE_BOOTSTRAP_FILENAMES } = await import("../src/agents/workspace.js");
    const di = STABLE_BOOTSTRAP_FILENAMES.indexOf("SOUL.default.md");
    const si = STABLE_BOOTSTRAP_FILENAMES.indexOf("SOUL.md");
    expect(di).toBeGreaterThanOrEqual(0);
    expect(si).toBeGreaterThan(di); // operator SOUL after the default → wins by recency
  });

  it("renders CLAUDE.md with agent name (Phase 2: persona moved to SOUL.md)", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational, direct",
        boundaries: "not a doctor",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    expect(claudeMd).toContain("health-coach");
    // Phase 2: persona content moved to SOUL.md
    expect(claudeMd).toContain("SOUL.md");
    expect(claudeMd).not.toContain("Coach");
    expect(claudeMd).not.toContain("motivational");

    // Persona should be in workspace/SOUL.md instead
    const soulMd = readFileSync(join(result.agentDir, "workspace", "SOUL.md"), "utf-8");
    expect(soulMd).toContain("Coach");
    expect(soulMd).toContain("motivational");
    expect(soulMd).toContain("not a doctor");
  });

  it("admin:true agent gets the admin branch in CLAUDE.md (klanker incident regression)", () => {
    // buildWorkspaceContext omitted `admin`, so scaffoldAgent (the
    // `switchroom apply` render path) always rendered the non-admin
    // `{{else}}` branch — admin agents were told "you are NOT admin".
    const adminCfg = makeAgentConfig({ extends: "default", admin: true });
    const a = scaffoldAgent("admin-agent", adminCfg, tmpDir, telegramConfig);
    const adminMd = readFileSync(join(a.agentDir, "CLAUDE.md"), "utf-8");
    expect(adminMd).toMatch(/Fleet operations live on the `hostd`/);
    expect(adminMd).toContain("update_apply");
    expect(adminMd).not.toMatch(/You're NOT `admin: true`/);

    const plainCfg = makeAgentConfig({ extends: "default" });
    const p = scaffoldAgent("plain-agent", plainCfg, tmpDir, telegramConfig);
    const plainMd = readFileSync(join(p.agentDir, "CLAUDE.md"), "utf-8");
    expect(plainMd).toMatch(/You're NOT `admin: true`/);
    expect(plainMd).not.toMatch(/Fleet operations live on the `hostd`/);
  });

  it("generates start.sh with correct env vars", () => {
    const config = makeAgentConfig({ topic_id: 42 });
    const result = scaffoldAgent("my-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("#!/bin/bash");
    // start.sh must source nvm so systemd user services find node on PATH
    expect(startSh).toContain('NVM_DIR="$HOME/.nvm"');
    expect(startSh).toContain("$NVM_DIR/nvm.sh");
    expect(startSh).toContain(`CLAUDE_CONFIG_DIR="${result.agentDir}/.claude"`);
    expect(startSh).toContain(`TELEGRAM_STATE_DIR="${result.agentDir}/telegram"`);
    // Fresh session every start — Hindsight auto-recall + handoff briefing
    expect(startSh).toContain("exec claude $CONTINUE_FLAG --dangerously-load-development-channels server:switchroom-telegram");
    expect(startSh).toContain('CONTINUE_FLAG=""');
    // Default: session-handoff enabled. start.sh reads .handoff.md and
    // merges it into --append-system-prompt; plugin reads .handoff-topic.
    expect(startSh).toContain(".handoff.md");
    expect(startSh).toContain("switchroom handoff");
    expect(startSh).not.toContain("TELEGRAM_TOPIC_ID");
    // SWITCHROOM_AGENT_NAME is the canonical "which agent am I" identifier the
    // telegram-plugin reads to detect self-restart commands. Must be set.
    expect(startSh).toContain('SWITCHROOM_AGENT_NAME="my-agent"');
    expect(startSh).not.toContain("SWITCHROOM_SOCKET_PATH");
    expect(startSh).not.toContain("--dangerously-skip-permissions");
    // Must NOT use $(node -v) since node isn't on PATH under systemd user units
    expect(startSh).not.toContain("$(node -v)");
  });

  it("start.sh launches the boot self-test from the in-container bin dir (#427, #4163)", () => {
    // The boot self-test is what surfaces broken agent auth on the Telegram
    // issues card. It was invoked as `{{repoRoot}}/bin/boot-self-test.sh`,
    // where repoRoot came from the CLI's own `import.meta.dirname` — a HOST
    // path baked into a script that only ever runs inside the container. Under
    // `bun build --compile` that is the bunfs root, so every scaffolded agent
    // got the literal `//bin/boot-self-test.sh`, the `-x` test failed, and the
    // self-test silently never ran. Guarded from three sides because the
    // failure mode was SILENCE: the invocation vanishing, or pointing anywhere
    // other than the image's own bin dir, must each go red.
    const config = makeAgentConfig();
    const result = scaffoldAgent("selftest-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // 1. It is still invoked at all.
    expect(startSh).toContain("boot-self-test.sh");
    // 2. From the path docker/Dockerfile.agent COPYs bin/*.sh to.
    expect(startSh).toContain('[ -x "/opt/switchroom/bin/boot-self-test.sh" ]');
    expect(startSh).toContain('( "/opt/switchroom/bin/boot-self-test.sh" >/dev/null 2>&1 ) &');
    // 3. And from NOWHERE else — not the `//bin/…` the bunfs root rendered,
    //    and not this repo's own path from a source checkout.
    for (const line of startSh.split("\n")) {
      if (!line.includes("boot-self-test.sh")) continue;
      if (line.trimStart().startsWith("#")) continue;
      expect(line, `unexpected boot-self-test path: ${line}`).toContain(
        '"/opt/switchroom/bin/boot-self-test.sh"',
      );
    }
    expect(startSh).not.toContain("//bin/boot-self-test.sh");
    expect(startSh).not.toContain(`${resolve(__dirname, "..")}/bin/boot-self-test.sh`);
  });

  it("start.sh does NOT export CLAUDE_CODE_OAUTH_TOKEN (RFC H §7.4)", () => {
    // Pre-RFC-H, start.sh exported CLAUDE_CODE_OAUTH_TOKEN from
    // <agentDir>/.claude/.oauth-token into the live claude process env.
    // RFC H Decision 5 deletes this path: claude reads
    // <agentDir>/.claude/credentials.json directly (broker-written),
    // and CLAUDE_CODE_OAUTH_TOKEN is stripped from subprocess env by
    // claude anyway. This test pins the deletion.
    const config = makeAgentConfig();
    const result = scaffoldAgent("token-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).not.toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(startSh).not.toContain(".oauth-token");
  });

  it("start.sh exports SWITCHROOM_CONFIG when a config path is passed, DEFERRING to a pre-set env", () => {
    // Without this export, `switchroom <anything>` from the agent's own
    // Bash tool fails with "No switchroom.yaml found" because the CLI's
    // search paths (cwd + ~/.switchroom) don't cover where the user
    // actually keeps their config. The telegram plugin already gets the
    // var via .mcp.json, but the Claude Code process itself doesn't
    // inherit that — start.sh has to export it.
    //
    // CRITICAL (silent model-drift bug): the baked value is the HOST path,
    // but in Docker compose.ts already set SWITCHROOM_CONFIG to the
    // in-container mount (/state/config/switchroom.yaml). An unconditional
    // `export SWITCHROOM_CONFIG=<host path>` clobbered that with a path
    // that does not exist in the container, so the live model/effort
    // resolvers' [ -f ] guard failed and every `model:` edit + bare
    // restart silently booted the stale bake. The export must be the
    // ${VAR:-bake} defer form, and these are OUTCOME assertions: the
    // rendered snippet is executed both ways.
    const config = makeAgentConfig();
    const configPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(configPath, "switchroom: { agents_dir: . }\n");
    const result = scaffoldAgent(
      "cfg-agent",
      config,
      tmpDir,
      telegramConfig,
      undefined,
      undefined,
      configPath,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Rendered form: bake assigned bare (pre-quoted), export defers to a
    // pre-set env var.
    expect(startSh).toContain(`_SR_CONFIG_BAKED='${configPath}'`);
    expect(startSh).toContain('export SWITCHROOM_CONFIG="${SWITCHROOM_CONFIG:-$_SR_CONFIG_BAKED}"');
    const exportIdx = startSh.indexOf("export SWITCHROOM_CONFIG=");
    const execIdx = startSh.indexOf("exec claude");
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeLessThan(execIdx);

    // Execute the rendered snippet. Extract exactly the assignment + export
    // lines so the outcome (which value wins) is tested, not the spelling.
    const snippet = startSh
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("_SR_CONFIG_BAKED=") ||
          l.startsWith("export SWITCHROOM_CONFIG=") ||
          l === "unset _SR_CONFIG_BAKED",
      )
      .join("\n");
    expect(snippet).not.toBe("");
    const runSnippet = (pre: string): string =>
      execFileSync("bash", ["-c", `${pre}\n${snippet}\necho "CFG=$SWITCHROOM_CONFIG"`], {
        encoding: "utf-8",
      })
        .match(/CFG=(.*)/)![1]
        .trim();
    // Docker case: compose already set the container path — it must WIN.
    expect(runSnippet("export SWITCHROOM_CONFIG=/state/config/switchroom.yaml")).toBe(
      "/state/config/switchroom.yaml",
    );
    // Host-run case: nothing pre-set — the bake is the fallback.
    expect(runSnippet("unset SWITCHROOM_CONFIG")).toBe(configPath);
    // Set-but-empty degenerates to the bake, never to an empty config path.
    expect(runSnippet('export SWITCHROOM_CONFIG=""')).toBe(configPath);
  });

  it("start.sh omits SWITCHROOM_CONFIG export when no config path is passed", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-cfg-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).not.toContain("export SWITCHROOM_CONFIG=");
    expect(startSh).not.toContain("_SR_CONFIG_BAKED=");
  });

  it("start.sh symlinks $HOME/.switchroom to host home (#910 tilde-path fix)", () => {
    // Container HOME=/state/agent/home (compose.ts) but operator yaml
    // prompts widely use ~/.switchroom/skills/..., ~/.switchroom/
    // credentials/..., etc. Without the symlink the tilde resolves to
    // a path that doesn't exist inside the container.
    const prevHome = process.env.HOME;
    // hostHomeForBake() prefers SWITCHROOM_HOST_HOME over HOME (src/agents/
    // scaffold.ts). In a hostd/container context that var is set to the real
    // host home, which would override our HOME fixture and bake a different
    // path — so clear it and let HOME drive the bake for this test.
    const prevHostHome = process.env.SWITCHROOM_HOST_HOME;
    process.env.HOME = "/home/op";
    delete process.env.SWITCHROOM_HOST_HOME;
    try {
      const config = makeAgentConfig();
      const result = scaffoldAgent("tilde-agent", config, tmpDir, telegramConfig);
      const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      // Symlink target is the host home, link path is $HOME/.switchroom.
      expect(startSh).toMatch(/ln -sfn '\/home\/op'\/\.switchroom "\$HOME\/\.switchroom"/);
      // Idempotent guard refuses to clobber a real directory.
      expect(startSh).toContain('[ ! -e "$HOME/.switchroom" ] || [ -L "$HOME/.switchroom" ]');
      // #1846: sibling symlink for the config repo so the in-container
      // CLI's resolveConfigSkillsDir finds the bind-mounted slice.
      expect(startSh).toMatch(/ln -sfn '\/home\/op'\/\.switchroom-config "\$HOME\/\.switchroom-config"/);
      expect(startSh).toContain('[ ! -e "$HOME/.switchroom-config" ] || [ -L "$HOME/.switchroom-config" ]');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevHostHome === undefined) delete process.env.SWITCHROOM_HOST_HOME;
      else process.env.SWITCHROOM_HOST_HOME = prevHostHome;
    }
  });

  it("start.sh skips the symlink block when HOME is unset (test/non-host context)", () => {
    const prevHome = process.env.HOME;
    const prevHostHome = process.env.SWITCHROOM_HOST_HOME;
    delete process.env.HOME;
    // SWITCHROOM_HOST_HOME now also feeds hostHomeQ (in-hostd bake fix); clear
    // it too so this stays a true "no host home" context.
    delete process.env.SWITCHROOM_HOST_HOME;
    try {
      const config = makeAgentConfig();
      const result = scaffoldAgent("no-home-agent", config, tmpDir, telegramConfig);
      const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      // Without hostHomeQ, the {{#if hostHomeQ}} guard renders nothing.
      expect(startSh).not.toContain('"$HOME/.switchroom"');
      expect(startSh).not.toContain('"$HOME/.switchroom-config"');
      expect(startSh).not.toContain("ln -sfn");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      if (prevHostHome !== undefined) process.env.SWITCHROOM_HOST_HOME = prevHostHome;
    }
  });

  it("start.sh includes --effort flag when thinking_effort is set", () => {
    const config = makeAgentConfig({ thinking_effort: "xhigh" });
    const result = scaffoldAgent("effort-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // #3039: the configured default seeds $_EFFECTIVE_EFFORT; a durable
    // .session-effort override may replace it at boot. The yaml value is
    // baked as the LAST-DITCH fallback only — $_EFFECTIVE_EFFORT is resolved
    // live from switchroom.yaml at boot (see the live-read test below).
    expect(startSh).toContain("_BAKED_EFFORT='xhigh'");
    expect(startSh).toContain('--effort $_EFFECTIVE_EFFORT');
  });

  it("start.sh resolves thinking_effort LIVE from switchroom.yaml, not just the bake", () => {
    // The effort sibling of the model live-read: editing `thinking_effort:`
    // and restarting must take effect WITHOUT a full `switchroom apply`.
    // Asserts the outcome that matters — the launcher asks the CLI resolver
    // against the live mounted config and prefers its answer over the bake.
    const config = makeAgentConfig({ thinking_effort: "high" });
    const result = scaffoldAgent("live-effort-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('agent effective-effort "live-effort-agent"');
    expect(startSh).toContain('switchroom --config "$SWITCHROOM_CONFIG" agent effective-effort');
    // Fallback chain: live → last-known-good → bake.
    expect(startSh).toContain("/.configured-default-effort");
    expect(startSh).toContain('_EFFECTIVE_EFFORT="$_le_live"');
    expect(startSh).toContain('_EFFECTIVE_EFFORT="$_LKG_EFFORT"');
    expect(startSh).toContain('_EFFECTIVE_EFFORT="$_BAKED_EFFORT"');
  });

  it("start.sh defaults --effort to 'low' when thinking_effort is not set in yaml", () => {
    // Switchroom default: chat-pattern main agents don't benefit from
    // extended thinking; effort=low cuts hidden thinking tokens to
    // near-zero on conversational replies. See
    // SWITCHROOM_DEFAULT_THINKING_EFFORT in src/agents/scaffold.ts.
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-effort-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("_BAKED_EFFORT='low'");
  });

  it("start.sh respects an explicit thinking_effort override", () => {
    const config = makeAgentConfig({ thinking_effort: "high" });
    const result = scaffoldAgent("explicit-effort", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("_BAKED_EFFORT='high'");
    expect(startSh).not.toContain("_BAKED_EFFORT='low'");
  });

  it("start.sh defaults --model to claude-sonnet-5 when model is not set in yaml", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-model-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The configured/default model is baked as the last-ditch fallback seed
    // ($_BAKED_MODEL, live-config resolution preferred at boot), and the exec
    // line passes the resolved value through via --model "$_EFFECTIVE_MODEL".
    expect(startSh).toContain("_BAKED_MODEL='claude-sonnet-5'");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
  });

  it("start.sh respects an explicit model override", () => {
    const config = makeAgentConfig({ model: "claude-opus-4-7" });
    const result = scaffoldAgent("opus-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The explicit yaml model is baked into the $_BAKED_MODEL seed and reaches launch.
    expect(startSh).toContain("_BAKED_MODEL='claude-opus-4-7'");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
    // The default sonnet model must NOT be baked as the fallback seed
    // (a doc comment may still reference it as an example — only the seed matters).
    expect(startSh).not.toContain("_BAKED_MODEL='claude-sonnet-5'");
  });

  it("start.sh includes --permission-mode flag when permission_mode is set", () => {
    const config = makeAgentConfig({ permission_mode: "plan" });
    const result = scaffoldAgent("perm-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--permission-mode plan");
  });

  it("start.sh omits --permission-mode when permission_mode is not set", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-perm-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).not.toContain("--permission-mode");
  });

  it("start.sh includes --fallback-model flag when fallback_model is set", () => {
    const config = makeAgentConfig({ fallback_model: "sonnet" });
    const result = scaffoldAgent("fallback-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--fallback-model 'sonnet'");
  });

  it("start.sh omits --fallback-model when fallback_model is not set", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-fallback-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).not.toContain("--fallback-model");
  });

  it("reconcile re-renders start.sh with thinking_effort flag", () => {
    const config = makeAgentConfig({ thinking_effort: "medium" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "effort-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("effort-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("effort-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(tmpDir, "effort-reconcile", "start.sh"), "utf-8");
    expect(startSh).toContain("_BAKED_EFFORT='medium'");
  });

  it("reconcile re-renders start.sh with permission_mode flag", () => {
    const config = makeAgentConfig({ permission_mode: "bypassPermissions" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "perm-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("perm-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("perm-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(tmpDir, "perm-reconcile", "start.sh"), "utf-8");
    expect(startSh).toContain("--permission-mode bypassPermissions");
  });

  it("reconcile pre-approves webkite MCP tools in permissions.allow", () => {
    // The live `switchroom apply` path reconciles EXISTING agents
    // (reconcileAgent), not scaffoldAgent. This pins that the reconcile
    // desiredAllow also carries mcp__webkite__* — the path that actually
    // runs on every restart/apply for a deployed fleet.
    const config = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "webkite-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("webkite-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("webkite-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const settings = JSON.parse(
      readFileSync(join(tmpDir, "webkite-reconcile", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__webkite__*");
  });

  it("reconcile re-renders start.sh with fallback_model flag", () => {
    const config = makeAgentConfig({ fallback_model: "sonnet" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "fallback-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("fallback-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("fallback-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(tmpDir, "fallback-reconcile", "start.sh"), "utf-8");
    expect(startSh).toContain("--fallback-model 'sonnet'");
  });

  it("scaffold wiring: documented callers write the clean-shutdown marker with a reason before restarting", () => {
    // Source-grep regression for the five documented call sites so a
    // future refactor can't silently drop the reason-stamping step.
    const lifecycleSrc = readFileSync(
      resolve(__dirname, "..", "src", "agents", "lifecycle.ts"),
      "utf-8",
    );
    const cliAgentSrc = readFileSync(
      resolve(__dirname, "..", "src", "cli", "agent.ts"),
      "utf-8",
    );
    const gatewaySrc = readFileSync(
      resolve(__dirname, "..", "telegram-plugin", "gateway", "gateway.ts"),
      "utf-8",
    );

    // Helper lives in lifecycle.ts and resolves the same file the gateway
    // writes (shared contract — if the path drifts, greetings go dark).
    expect(lifecycleSrc).toContain("export function writeRestartReasonMarker");
    expect(lifecycleSrc).toContain("clean-shutdown.json");

    // CLI restart + reconcile-with-restart stamp a reason.
    expect(cliAgentSrc).toContain("writeRestartReasonMarker");
    expect(cliAgentSrc).toMatch(/buildCliRestartReason/);
    expect(cliAgentSrc).toMatch(/reconcile:\s/);

    // (`switchroom update` was removed in v0.7. Restart-reason
    // stamping for bulk operations now sits on the operator's
    // docker-compose flow and the per-agent restart path above.)

    // (bridge-watchdog.sh was removed in v0.7 PR-A3 — docker container
    // restart policies replace the legacy systemd-watchdog path.)

    // Gateway user-slash paths stamp a user-attributed reason.
    expect(gatewaySrc).toContain("function stampUserRestartReason");
    expect(gatewaySrc).toContain("user: /restart from chat");
    expect(gatewaySrc).toMatch(/user: \/\$\{kind\} from chat/);
  });

  it("generates telegram .env with bot token", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("bot-agent", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=123456:ABC-DEF");
  });

  it("generates access.json with group config", () => {
    const config = makeAgentConfig({ topic_id: 99 });
    const result = scaffoldAgent("filtered", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );

    expect(access.dmPolicy).toBe("allowlist");
    expect(Array.isArray(access.allowFrom)).toBe(true);
    expect(access.groups).toBeDefined();
    expect(access.groups["-1001234567890"]).toBeDefined();
    expect(access.groups["-1001234567890"].requireMention).toBe(false);
  });

  it("generates telegram/people.json (empty entries) even with no users: block", () => {
    const config = makeAgentConfig({});
    const result = scaffoldAgent("no-people", config, tmpDir, telegramConfig);
    const people = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "people.json"), "utf-8"),
    );
    expect(people).toEqual({ entries: [] });
  });

  it("projects users: person_id entries into telegram/people.json (raw, undeduped)", () => {
    const config = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      users: {
        lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile", person_id: "Lisa" },
        ken: { telegram_ids: ["111"], profile_bank: "ken-profile" }, // no person_id — excluded
      },
      agents: { "people-agent": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent("people-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const people = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "people.json"), "utf-8"),
    );
    expect(people.entries).toEqual([{ key: "lisa", person_id: "Lisa", telegram_ids: ["8201250670"] }]);
  });

  it("people.json is config-derived — re-scaffolding (the `switchroom apply` reconcile path) regenerates it, unlike writeIfMissing access.json", () => {
    const config = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      users: { lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile", person_id: "Lisa" } },
      agents: { "people-rescaffold": config },
    } as SwitchroomConfig;
    scaffoldAgent("people-rescaffold", config, tmpDir, telegramConfig, switchroomConfig);

    // Simulate a users: edit, then re-run `switchroom apply` (which calls
    // scaffoldAgent again, idempotently, for every configured agent) —
    // people.json must pick up the change, unlike the writeIfMissing
    // access.json.
    const switchroomConfig2: SwitchroomConfig = {
      ...switchroomConfig,
      users: { lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile", person_id: "Lisa Renamed" } },
    } as SwitchroomConfig;
    scaffoldAgent("people-rescaffold", config, tmpDir, telegramConfig, switchroomConfig2);
    const people = JSON.parse(
      readFileSync(join(tmpDir, "people-rescaffold", "telegram", "people.json"), "utf-8"),
    );
    expect(people.entries[0].person_id).toBe("Lisa Renamed");
  });

  it("projects channels.telegram.coalesce.window_ms into access.coalescingGapMs", () => {
    const config = makeAgentConfig({
      channels: { telegram: { coalesce: { window_ms: 1200 } } },
    });
    const result = scaffoldAgent("coalesce-agent", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect(access.coalescingGapMs).toBe(1200);
  });

  it("projects window_ms: 0 (coalescing disabled) — not dropped as falsy", () => {
    const config = makeAgentConfig({
      channels: { telegram: { coalesce: { window_ms: 0 } } },
    });
    const result = scaffoldAgent("coalesce-off", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect(access.coalescingGapMs).toBe(0);
  });

  it("omits coalescingGapMs entirely when no coalesce config is set", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("coalesce-default", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect("coalescingGapMs" in access).toBe(false);
  });

  it("projects channels.telegram.litellm_notice.window_ms into access.litellmNoticeWindowMs", () => {
    const config = makeAgentConfig({
      channels: { telegram: { litellm_notice: { window_ms: 600_000 } } },
    });
    const result = scaffoldAgent("litellm-notice-agent", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect(access.litellmNoticeWindowMs).toBe(600_000);
  });

  it("omits litellmNoticeWindowMs entirely when no litellm_notice config is set (gateway applies the 15-min default)", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("litellm-notice-default", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect("litellmNoticeWindowMs" in access).toBe(false);
  });

  it("projects channels.telegram.interrupt into access (safe_boundary + max_wait_ms)", () => {
    const config = makeAgentConfig({
      channels: { telegram: { interrupt: { safe_boundary: true, max_wait_ms: 5000 } } },
    });
    const result = scaffoldAgent("interrupt-agent", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect(access.interruptSafeBoundary).toBe(true);
    expect(access.interruptMaxWaitMs).toBe(5000);
  });

  it("projects interrupt.safe_boundary: false — not dropped as falsy", () => {
    const config = makeAgentConfig({
      channels: { telegram: { interrupt: { safe_boundary: false } } },
    });
    const result = scaffoldAgent("interrupt-off", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect(access.interruptSafeBoundary).toBe(false);
  });

  it("omits interrupt fields entirely when no interrupt config is set", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("interrupt-default", config, tmpDir, telegramConfig);
    const access = JSON.parse(
      readFileSync(join(result.agentDir, "telegram", "access.json"), "utf-8"),
    );
    expect("interruptSafeBoundary" in access).toBe(false);
    expect("interruptMaxWaitMs" in access).toBe(false);
  });

  it("generates settings.json with tool permissions (webkite staged → WebFetch denied)", () => {
    // Simulate the webkite binary being staged so the fail-safe gate
    // (webkiteBinaryAvailable) trips and the deny applies. Point the
    // override env at a real file under tmpDir.
    const fakeWebkite = join(tmpDir, "webkite-bin");
    writeFileSync(fakeWebkite, "#!/bin/sh\n");
    const prev = process.env.SWITCHROOM_WEBKITE_BINARY;
    process.env.SWITCHROOM_WEBKITE_BINARY = fakeWebkite;
    try {
      const config = makeAgentConfig({
        tools: { allow: ["calendar", "notion"], deny: ["bash"] },
      });
      const result = scaffoldAgent("tools-agent", config, tmpDir, telegramConfig);
      const settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );

      // User-declared tools end up on the allowlist
      expect(settings.permissions.allow).toContain("calendar");
      expect(settings.permissions.allow).toContain("notion");
      // #235: switchroom-mcp deprecated — mcp__switchroom__* is no longer
      // pre-approved (the underlying server is removed).
      expect(settings.permissions.allow).not.toContain("mcp__switchroom__*");
      // Webkite is fleet-default (scaffold.ts:WEBKITE_FLEET_DENY_TOOLS) —
      // the native WebFetch tool is denied (native WebSearch stays available) so the model
      // reaches for the webkite_* MCP tools instead. Per-agent
      // `mcp_servers.webkite: false` opts both webkite AND this deny
      // out together.
      // "AskUserQuestion" is the unconditional fleet-baseline interactive-TUI
      // deny (scaffold.ts:INTERACTIVE_TUI_FLEET_DENY_TOOLS), appended after the
      // webkite strip.
      expect(settings.permissions.deny).toEqual([
        "bash",
        "WebFetch",
        "AskUserQuestion",
      ]);
      // acceptEdits is now the switchroom built-in default for EVERY agent
      // (decoupled from the `[all]` wildcard) — a plain non-wildcard agent
      // with no permission_mode / no fleet default gets it too.
      expect(settings.permissions.defaultMode).toBe("acceptEdits");
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_WEBKITE_BINARY;
      else process.env.SWITCHROOM_WEBKITE_BINARY = prev;
    }
  });

  it("webkite MCP tools are pre-approved in permissions.allow (no first-use prompt)", () => {
    // Webkite replaces native WebFetch — the first "read this URL" is a
    // guaranteed, common turn. If webkite_* tools aren't pre-approved,
    // that call wedges on a Claude Code permission prompt. Pre-approval
    // is gated only on the per-agent opt-out (NOT on binary presence),
    // matching when the MCP entry is emitted.
    const config = makeAgentConfig({});
    const result = scaffoldAgent("webkite-allow-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__webkite__*");
    expect(settings.permissions.allow).toContain("mcp__webkite");
  });

  it("re-seeds webkite pre-approval into an EXISTING agent's allow (merge path)", () => {
    // The bug this guards: `switchroom apply` on a deployed (existing)
    // agent hits writeIfMissing — which SKIPS the settings.json template
    // — then the MCP-merge block re-seeds allow. Pre-fix that block only
    // re-seeded agent-config + hostd, so webkite never reached existing
    // agents' allow and every deployed agent's first webkite_* call
    // wedged on a permission prompt (caught live on the v0.13.63 fleet).
    const config = makeAgentConfig({});
    // First scaffold creates settings.json (fresh path — has webkite).
    const result = scaffoldAgent("wk-existing", config, tmpDir, telegramConfig, {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "wk-existing": config },
    } as SwitchroomConfig);
    const settingsPath = join(result.agentDir, ".claude", "settings.json");
    // Simulate a PRE-webkite deployed agent: strip webkite from allow.
    const s1 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    s1.permissions.allow = s1.permissions.allow.filter(
      (x: string) => !x.includes("webkite"),
    );
    writeFileSync(settingsPath, JSON.stringify(s1, null, 2));
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow)
      .not.toContain("mcp__webkite__*");
    // Re-scaffold (existing-agent merge path) must re-seed webkite.
    scaffoldAgent("wk-existing", config, tmpDir, telegramConfig, {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "wk-existing": config },
    } as SwitchroomConfig);
    const s2 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(s2.permissions.allow).toContain("mcp__webkite__*");
  });

  it("pre-approves native WebSearch fleet-wide even for an explicit-allow (acceptEdits) agent", () => {
    // The uniformity gap this guards: an agent with an explicit `tools.allow`
    // (acceptEdits-mode agents like kdogg/marko) SKIPS
    // DEFAULT_READ_ONLY_PREAPPROVED_TOOLS, so a WebSearch pre-approval seeded
    // only via the read-only defaults would never reach them. WebSearch is
    // pre-approved as an UNCONDITIONAL spread instead, so every agent —
    // explicit-allow or not — gets it. WebFetch stays gated (webkite path).
    const config = makeAgentConfig({
      tools: { allow: ["calendar", "notion"], deny: ["bash"] },
    });
    const result = scaffoldAgent("websearch-explicit", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    // The explicit tools survive AND WebSearch is pre-approved alongside them.
    expect(settings.permissions.allow).toContain("calendar");
    expect(settings.permissions.allow).toContain("WebSearch");
    // WebFetch is NOT pre-approved — page fetches still route through webkite.
    expect(settings.permissions.allow).not.toContain("WebFetch");
  });

  it("reconcile pre-approves native WebSearch in permissions.allow", () => {
    // The live `switchroom apply` path reconciles EXISTING agents
    // (reconcileAgent) and assigns computeDesiredPermissionAllow's output
    // wholesale — pin that native WebSearch rides that path too.
    const config = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "websearch-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("websearch-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("websearch-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const settings = JSON.parse(
      readFileSync(join(tmpDir, "websearch-reconcile", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("WebSearch");
    expect(settings.permissions.allow).not.toContain("WebFetch");
  });

  it("re-seeds native WebSearch into an EXISTING agent's allow (merge path)", () => {
    // Twin of the webkite existing-agent merge test: `switchroom apply` on a
    // deployed agent hits writeIfMissing (skips the settings.json template),
    // so the additive MCP-merge block must re-seed native WebSearch or a
    // pre-WebSearch deployed agent never picks it up until it next reconciles.
    const config = makeAgentConfig({});
    const result = scaffoldAgent("ws-existing", config, tmpDir, telegramConfig, {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ws-existing": config },
    } as SwitchroomConfig);
    const settingsPath = join(result.agentDir, ".claude", "settings.json");
    // Simulate a PRE-WebSearch deployed agent: strip WebSearch from allow.
    const s1 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    s1.permissions.allow = s1.permissions.allow.filter((x: string) => x !== "WebSearch");
    writeFileSync(settingsPath, JSON.stringify(s1, null, 2));
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow)
      .not.toContain("WebSearch");
    // Re-scaffold (existing-agent merge path) must re-seed WebSearch.
    scaffoldAgent("ws-existing", config, tmpDir, telegramConfig, {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ws-existing": config },
    } as SwitchroomConfig);
    const s2 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(s2.permissions.allow).toContain("WebSearch");
  });

  it("context7 MCP entry is wired into .mcp.json by default (remote HTTP)", () => {
    // Fleet-default capability, no opt-in gate. Asserts the OUTCOME the
    // operator cares about — the server is reachable from the agent's
    // session — not merely that the resolver was called. Pinning the
    // transport shape matters: an accidental switch to `npx -y
    // @upstash/context7-mcp` reintroduces a per-boot npm-registry fetch
    // of an unpinned third-party package inside the container.
    const config = makeAgentConfig({});
    // .mcp.json's integration loop is gated on switchroomConfig being
    // present (scaffold.ts Site 2), so pass one — without it the file
    // carries no framework integrations at all and the assertion below
    // would pass vacuously for the wrong reason.
    const result = scaffoldAgent("ctx7-agent", config, tmpDir, telegramConfig, {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-agent": config },
    } as SwitchroomConfig);
    const mcp = JSON.parse(readFileSync(join(result.agentDir, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.context7).toEqual({
      type: "http",
      url: "https://mcp.context7.com/mcp",
    });
    // No credential is wired — the free tier is anonymous, and a stray
    // env/header block here would be a secret leak into a 0600 file.
    expect(mcp.mcpServers.context7.env).toBeUndefined();
    expect(mcp.mcpServers.context7.headers).toBeUndefined();
  });

  it("context7 lands on the .claude.json MCP trust allowlist", () => {
    // Observed live on 2026-07-26: `claude mcp list` against a project
    // .mcp.json holding the context7 HTTP entry reports
    // "⏸ Pending approval" until the server name is in .claude.json's
    // enabledMcpjsonServers. Claude Code SILENTLY ignores untrusted
    // project servers — so without this the server is wired, the tools
    // are pre-approved, the prompt tells agents to use it, and the
    // capability still does not exist at runtime with no error anywhere.
    const config = makeAgentConfig({});
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-trust": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "ctx7-trust", config, tmpDir, telegramConfig, switchroomConfig,
    );
    const claudeJson = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", ".claude.json"), "utf-8"),
    );
    // Key by the agent's OWN project path, never the first entry of the
    // projects map. scaffoldAgent copies the host's onboarding state, so
    // `projects` also carries whatever directories the operator has already
    // used Claude Code in. On a machine with any such history the first
    // entry is one of those (with an empty `enabledMcpjsonServers`) and the
    // assertion failed for a reason unrelated to the guarantee under test,
    // while passing on a clean CI runner (#4106).
    const projectKey = resolve(result.agentDir);
    const projectEntry = (
      claudeJson.projects as Record<string, { enabledMcpjsonServers?: string[] }>
    )[projectKey];
    expect(projectEntry?.enabledMcpjsonServers).toContain("context7");
    // Reconcile must keep it trusted (the path every deployed agent takes).
    reconcileAgent("ctx7-trust", config, tmpDir, telegramConfig, switchroomConfig);
    const after = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", ".claude.json"), "utf-8"),
    );
    expect(
      (after.projects as Record<string, { enabledMcpjsonServers?: string[] }>)[
        projectKey
      ]?.enabledMcpjsonServers,
    ).toContain("context7");
  });

  it("context7 opt-out removes BOTH the .mcp.json entry and the pre-approval", () => {
    const config = makeAgentConfig(
      { mcp_servers: { context7: false } } as Partial<AgentConfig>,
    );
    const result = scaffoldAgent(
      "ctx7-optout-agent", config, tmpDir, telegramConfig,
      {
        switchroom: { version: 1, agents_dir: tmpDir },
        telegram: telegramConfig,
        agents: { "ctx7-optout-agent": config },
      } as SwitchroomConfig,
    );
    const mcp = JSON.parse(readFileSync(join(result.agentDir, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.context7).toBeUndefined();
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).not.toContain(
      "mcp__context7__resolve-library-id",
    );
    expect(settings.permissions.allow).not.toContain("mcp__context7__query-docs");
    // No blanket grant either, in any form.
    expect(settings.permissions.allow).not.toContain("mcp__context7__*");
    expect(settings.permissions.allow).not.toContain("mcp__context7");
    // Opting out of context7 must NOT disturb webkite — they're
    // independent fleet defaults sharing only the opt-out mechanism.
    expect(mcp.mcpServers.webkite).toBeDefined();
    expect(settings.permissions.allow).toContain("mcp__webkite__*");
  });

  it("context7 MCP tools are pre-approved in permissions.allow (no first-use prompt)", () => {
    // LIBRARY_DOCS_GUIDANCE instructs every agent to look library docs
    // up BEFORE answering an API question, so the first context7 call is
    // guaranteed and common. Un-approved, it wedges the turn on a
    // Telegram permission prompt — which teaches the agent the tool is
    // expensive and re-creates the provisioned-but-unused failure.
    const config = makeAgentConfig({});
    const result = scaffoldAgent("ctx7-allow-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain(
      "mcp__context7__resolve-library-id",
    );
    expect(settings.permissions.allow).toContain("mcp__context7__query-docs");
  });

  it("pre-approves context7 by ENUMERATION — never a wildcard over a third-party namespace", () => {
    // The security-relevant assertion of this whole change. context7's
    // tool surface lives on a remote endpoint Upstash controls, unlike
    // webkite (an operator-built binary). A `mcp__context7__*` grant
    // would auto-approve whatever verb they ship next, on every fleet
    // agent, with no approval card and no config change here — so the
    // wildcard must never come back. Same narrowing as HOSTD_MCP_TOOLS.
    const config = makeAgentConfig({});
    const result = scaffoldAgent("ctx7-narrow", config, tmpDir, telegramConfig);
    const allow: string[] = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    ).permissions.allow;
    expect(allow).not.toContain("mcp__context7__*");
    // The bare server token approves the WHOLE server and would defeat
    // the enumeration just as thoroughly as the wildcard.
    expect(allow).not.toContain("mcp__context7");
    expect(allow.filter((t) => t.startsWith("mcp__context7"))).toEqual([
      "mcp__context7__resolve-library-id",
      "mcp__context7__query-docs",
    ]);
  });

  it("retracts context7 pre-approval from an EXISTING agent that opts out (merge path)", () => {
    // The merge path is union-only by default, and it is the path every
    // one of the deployed agents takes on `switchroom apply`. Without an
    // explicit retraction, `mcp_servers.context7: false` would drop the
    // .mcp.json server but leave the pre-approval tokens — including a
    // blanket grant from an in-development build — behind forever.
    const config = makeAgentConfig({});
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-merge-retract": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "ctx7-merge-retract", config, tmpDir, telegramConfig, switchroomConfig,
    );
    const settingsPath = join(result.agentDir, ".claude", "settings.json");
    // Simulate an agent that also carries the blanket grant.
    const s1 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    s1.permissions.allow.push("mcp__context7", "mcp__context7__*");
    writeFileSync(settingsPath, JSON.stringify(s1, null, 2));
    // Re-apply with the opt-out set — merge path, existing settings.json.
    const optedOut = makeAgentConfig(
      { mcp_servers: { context7: false } } as Partial<AgentConfig>,
    );
    scaffoldAgent("ctx7-merge-retract", optedOut, tmpDir, telegramConfig, {
      ...switchroomConfig,
      agents: { "ctx7-merge-retract": optedOut },
    } as SwitchroomConfig);
    const after: string[] = JSON.parse(
      readFileSync(settingsPath, "utf-8"),
    ).permissions.allow;
    expect(after.filter((t) => t.startsWith("mcp__context7"))).toEqual([]);
    // ...and webkite's pre-approval is untouched by the retraction.
    expect(after).toContain("mcp__webkite__*");
  });

  it("merge-path retraction never strips a token the agent DECLARES in tools.allow", () => {
    // Contradictory-but-legal config: opted out of the server yet still
    // declaring the tool. reconcileAgent assigns
    // computeDesiredPermissionAllow's output wholesale and that output
    // always includes the declared list, opt-out or not — so if this
    // path stripped a declared token, apply and reconcile would disagree
    // and the file would flip-flop on alternating runs. Operator config
    // wins; the retraction only cleans up switchroom-seeded tokens.
    const config = makeAgentConfig({
      mcp_servers: { context7: false },
      tools: { allow: ["mcp__context7__query-docs"], deny: [] },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-declared": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "ctx7-declared", config, tmpDir, telegramConfig, switchroomConfig,
    );
    // Second pass = the existing-agent merge path.
    scaffoldAgent("ctx7-declared", config, tmpDir, telegramConfig, switchroomConfig);
    const allow: string[] = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    ).permissions.allow;
    expect(allow).toContain("mcp__context7__query-docs");
    // ...but the token switchroom would have seeded is still gone.
    expect(allow).not.toContain("mcp__context7__resolve-library-id");
  });

  it("re-seeds context7 pre-approval into an EXISTING agent's allow (merge path)", () => {
    // Existing-agent twin of the webkite merge-path test below/above:
    // `switchroom apply` on a DEPLOYED agent hits writeIfMissing, which
    // skips the settings.json template, so only the MCP-merge block can
    // land the new pre-approval. Every one of the twelve live agents
    // takes this path — if it doesn't re-seed, this whole change ships
    // as a permission prompt rather than a capability.
    const config = makeAgentConfig({});
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-existing": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "ctx7-existing", config, tmpDir, telegramConfig, switchroomConfig,
    );
    const settingsPath = join(result.agentDir, ".claude", "settings.json");
    // Simulate a PRE-context7 deployed agent: strip context7 from allow.
    const s1 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    s1.permissions.allow = s1.permissions.allow.filter(
      (x: string) => !x.includes("context7"),
    );
    writeFileSync(settingsPath, JSON.stringify(s1, null, 2));
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow)
      .not.toContain("mcp__context7__resolve-library-id");
    // Re-scaffold (existing-agent merge path) must re-seed context7.
    scaffoldAgent("ctx7-existing", config, tmpDir, telegramConfig, switchroomConfig);
    const s2 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(s2.permissions.allow).toContain("mcp__context7__resolve-library-id");
    expect(s2.permissions.allow).toContain("mcp__context7__query-docs");
    expect(s2.permissions.allow).not.toContain("mcp__context7__*");
  });

  it("reconcile pre-approves context7 MCP tools in permissions.allow", () => {
    const config = makeAgentConfig({});
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("ctx7-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("ctx7-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const settings = JSON.parse(
      readFileSync(join(tmpDir, "ctx7-reconcile", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain(
      "mcp__context7__resolve-library-id",
    );
    expect(settings.permissions.allow).toContain("mcp__context7__query-docs");
    expect(settings.permissions.allow).not.toContain("mcp__context7__*");
  });

  it("retracts a stale context7 entry from .mcp.json when the agent opts out", () => {
    // Emit/retract symmetry: an agent that had context7 and then set
    // `mcp_servers.context7: false` must lose the .mcp.json entry, not
    // keep a dangling server the model can still call.
    const config = makeAgentConfig({});
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ctx7-retract": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "ctx7-retract", config, tmpDir, telegramConfig, switchroomConfig,
    );
    const mcpPath = join(result.agentDir, ".mcp.json");
    expect(JSON.parse(readFileSync(mcpPath, "utf-8")).mcpServers.context7)
      .toBeDefined();
    const optedOut = makeAgentConfig(
      { mcp_servers: { context7: false } } as Partial<AgentConfig>,
    );
    reconcileAgent("ctx7-retract", optedOut, tmpDir, telegramConfig, {
      ...switchroomConfig,
      agents: { "ctx7-retract": optedOut },
    } as SwitchroomConfig);
    expect(JSON.parse(readFileSync(mcpPath, "utf-8")).mcpServers.context7)
      .toBeUndefined();
  });

  it("webkite opt-out removes the pre-approval too", () => {
    const config = makeAgentConfig({ mcp_servers: { webkite: false } } as Partial<AgentConfig>);
    const result = scaffoldAgent("webkite-optout-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).not.toContain("mcp__webkite__*");
  });

  it("fail-safe: webkite binary ABSENT → native WebFetch/WebSearch kept", () => {
    // The fleet-default deny is gated on a webkite binary actually
    // being staged (webkiteBinaryAvailable). When it's absent — fresh
    // install, operator hasn't run setup, or a glibc-incompatible
    // build was pulled — the agent must KEEP native WebFetch as a
    // safety net rather than losing web access entirely. Point the
    // override at a path that does not exist.
    const prev = process.env.SWITCHROOM_WEBKITE_BINARY;
    process.env.SWITCHROOM_WEBKITE_BINARY = join(tmpDir, "does-not-exist-webkite");
    try {
      const config = makeAgentConfig({
        tools: { allow: ["calendar"], deny: ["bash"] },
      });
      const result = scaffoldAgent("nofetch-agent", config, tmpDir, telegramConfig);
      const settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );
      // No WebFetch/WebSearch strip — but the AskUserQuestion fleet-baseline
      // deny is unconditional (independent of webkite), so it still lands.
      expect(settings.permissions.deny).toEqual(["bash", "AskUserQuestion"]);
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_WEBKITE_BINARY;
      else process.env.SWITCHROOM_WEBKITE_BINARY = prev;
    }
  });

  it("AskUserQuestion is denied fleet-wide regardless of webkite presence", () => {
    // The blocking interactive-TUI selector wedges a headless,
    // Telegram-driven agent (no human at the terminal to answer it).
    // Denying it forces claude's graceful plain-text fallback. This deny
    // is unconditional — it must land whether or not webkite is staged
    // and with no per-agent config opting into it.
    const prev = process.env.SWITCHROOM_WEBKITE_BINARY;
    process.env.SWITCHROOM_WEBKITE_BINARY = join(tmpDir, "no-webkite-here");
    try {
      const config = makeAgentConfig({}); // no tools.deny, webkite absent
      const result = scaffoldAgent("askq-agent", config, tmpDir, telegramConfig);
      const settings = JSON.parse(
        readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
      );
      expect(settings.permissions.deny).toContain("AskUserQuestion");
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_WEBKITE_BINARY;
      else process.env.SWITCHROOM_WEBKITE_BINARY = prev;
    }
  });

  it("scaffoldAgent re-seeds AskUserQuestion deny into an EXISTING agent (apply path)", () => {
    // Mirrors the webkite allow re-seed guard. A deployed agent that
    // predates this deny must converge on it at the next `switchroom
    // apply`, which calls scaffoldAgent — whose existing-agent merge
    // branch additively re-seeds settings.permissions.deny (writeIfMissing
    // skips the template for existing agents, so the fresh-path deny never
    // lands). This is the convergence path that matters for live agents;
    // the reconcileAgent path shares the same dedupe spread.
    const config = makeAgentConfig({});
    const cfg = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "askq-existing": config },
    } as SwitchroomConfig;
    const result = scaffoldAgent("askq-existing", config, tmpDir, telegramConfig, cfg);
    const settingsPath = join(result.agentDir, ".claude", "settings.json");
    // Simulate a pre-deny deployed agent: strip AskUserQuestion from deny.
    const s1 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    s1.permissions.deny = (s1.permissions.deny as string[]).filter(
      (x) => x !== "AskUserQuestion",
    );
    writeFileSync(settingsPath, JSON.stringify(s1, null, 2));
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.deny)
      .not.toContain("AskUserQuestion");
    // Re-scaffold (existing-agent reconcile path) must re-seed it.
    scaffoldAgent("askq-existing", config, tmpDir, telegramConfig, cfg);
    const s2 = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(s2.permissions.deny).toContain("AskUserQuestion");
  });

  // #1400 apex-chain link 1: the hostd MCP server exposes mutating /
  // host-control verbs (update_apply, agent_exec, agent_restart, …).
  // The pre-#1400 scaffold blanket-pre-approved `mcp__hostd__*`, so a
  // prompt-injected admin agent could invoke them with NO Telegram
  // approval prompt. Only the pure read-only `update_check` may be
  // pre-approved; everything else must fall through to the human
  // approval card. A typo here silently re-wedges or re-opens the
  // chain — same drift-guard rationale as the switchroom-telegram
  // tool-list test below.
  it("pre-approves ONLY hostd update_check, never the mutating verbs or the blanket wildcard", () => {
    const config = makeAgentConfig({ tools: { allow: [], deny: [] } });
    const result = scaffoldAgent("hostd-narrow", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow: string[] = settings.permissions.allow;

    // The one safe read-only verb stays pre-approved (no first-use wedge).
    expect(allow).toContain("mcp__hostd__update_check");
    // The blanket grants are gone.
    expect(allow).not.toContain("mcp__hostd");
    expect(allow).not.toContain("mcp__hostd__*");
    // Every mutating / host-control verb must be ABSENT so it routes
    // through the Telegram approval card.
    for (const verb of [
      "mcp__hostd__update_apply",
      "mcp__hostd__agent_exec",
      "mcp__hostd__agent_restart",
      "mcp__hostd__agent_start",
      "mcp__hostd__agent_stop",
      "mcp__hostd__agent_logs",
      // #2487: the safe staggered rollout is mutating + a more surgical
      // abuse surface (--agents + arbitrary --pin) than update_apply, so
      // it MUST stay out of the pre-approved set — every agent call
      // surfaces a Telegram approval card.
      "mcp__hostd__rollout",
    ]) {
      expect(allow).not.toContain(verb);
    }
  });

  it("reconcile actively retracts a pre-existing blanket mcp__hostd__* from settings.json", () => {
    const config = makeAgentConfig({ tools: { allow: [], deny: [] } });
    const scaffolded = scaffoldAgent("hostd-retract", config, tmpDir, telegramConfig);
    const settingsPath = join(scaffolded.agentDir, ".claude", "settings.json");

    // Simulate a pre-#1400 agent: hand-inject the old blanket grant
    // into the persisted allowlist the way old scaffolds baked it in.
    const pre = JSON.parse(readFileSync(settingsPath, "utf-8"));
    pre.permissions.allow = [
      ...pre.permissions.allow.filter(
        (t: string) => t !== "mcp__hostd__update_check",
      ),
      "mcp__hostd",
      "mcp__hostd__*",
    ];
    writeFileSync(settingsPath, JSON.stringify(pre, null, 2));

    reconcileAgent(
      "hostd-retract",
      config,
      tmpDir,
      telegramConfig,
      {
        switchroom: { version: 1, agents_dir: tmpDir },
        telegram: telegramConfig,
        agents: { "hostd-retract": config },
      } as SwitchroomConfig,
    );

    const after: string[] = JSON.parse(
      readFileSync(settingsPath, "utf-8"),
    ).permissions.allow;
    expect(after).not.toContain("mcp__hostd");
    expect(after).not.toContain("mcp__hostd__*");
    expect(after).toContain("mcp__hostd__update_check");
  });

  it("expands tools.allow: [all] into the full built-in tool list", () => {
    // Claude Code rejects the literal string "all" in permissions.allow.
    // When users write `tools.allow: [all]` in switchroom.yaml, the scaffold
    // expands it to the full set of built-in Claude Code tools so the
    // agent never blocks on a runtime permission prompt.
    const config = makeAgentConfig({
      tools: { allow: ["all"], deny: [] },
    });
    const result = scaffoldAgent("all-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Critical built-ins must be present
    for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Glob", "Grep"]) {
      expect(settings.permissions.allow).toContain(t);
    }
    // Backstop defaultMode is also set
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    // No literal "all" leaks through
    expect(settings.permissions.allow).not.toContain("all");
  });

  it("pre-approves switchroom-telegram MCP tool names when channels.telegram.plugin is 'switchroom'", () => {
    const config = makeAgentConfig({
      tools: { allow: ["calendar"], deny: [] },
      channels: { telegram: { plugin: "switchroom" } },
    });
    const result = scaffoldAgent("fork-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toContain("calendar");

    // Assert every tool name registered by the plugin is in the allowlist.
    // Drift between the plugin's tool registry and the scaffolded permission
    // list silently breaks pre-approval — agents fall back to per-call
    // permission prompts. This test catches the drift the next time it
    // happens (PR #121 review found progress_update missing from this list
    // after delete_message and get_recent_messages were added).
    const expectedTools = [
      "mcp__switchroom-telegram", // bare server name
      "mcp__switchroom-telegram__reply",
      "mcp__switchroom-telegram__react",
      "mcp__switchroom-telegram__edit_message",
      "mcp__switchroom-telegram__send_typing",
      "mcp__switchroom-telegram__delete_message",
      "mcp__switchroom-telegram__forward_message",
      "mcp__switchroom-telegram__download_attachment",
      "mcp__switchroom-telegram__get_recent_messages",
      "mcp__switchroom-telegram__progress_update",
      "mcp__switchroom-telegram__send_checklist",
      "mcp__switchroom-telegram__update_checklist",
    ];
    for (const tool of expectedTools) {
      expect(settings.permissions.allow).toContain(tool);
    }
  });

  it("writes project-level .mcp.json when channels.telegram.plugin is 'switchroom'", () => {
    const agentConfig = makeAgentConfig({ channels: { telegram: { plugin: "switchroom" } } });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "fork-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "fork-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/fake/switchroom.yaml",
    );

    const mcpJsonPath = join(result.agentDir, ".mcp.json");
    expect(existsSync(mcpJsonPath)).toBe(true);

    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(mcpJson.mcpServers).toBeDefined();
    expect(mcpJson.mcpServers["switchroom-telegram"]).toBeDefined();
    expect(mcpJson.mcpServers["switchroom-telegram"].command).toBe("bun");
    // #1892: TELEGRAM_STATE_DIR is hardcoded to the in-container view so
    // host CLI and in-container CLI writes don't flip the on-disk file.
    expect(mcpJson.mcpServers["switchroom-telegram"].env.TELEGRAM_STATE_DIR).toBe(
      "/state/agent/home/.switchroom/agents/fork-agent/telegram",
    );
    expect(mcpJson.mcpServers["switchroom-telegram"].env.SWITCHROOM_CONFIG).toBe(
      "/state/config/switchroom.yaml",
    );
    expect(mcpJson.mcpServers["switchroom-telegram"].env.SWITCHROOM_CLI_PATH).toBe(
      "/usr/local/bin/switchroom",
    );
  });

  it("does not write .mcp.json when channels.telegram.plugin is 'official'", () => {
    const config = makeAgentConfig({ channels: { telegram: { plugin: "official" } } });
    const result = scaffoldAgent("plain-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(false);
  });

  // PR δ (#1175 RFC C Phase 3): admin agents get the `hostd` MCP wired
  // into .mcp.json so the agent's Claude session can call hostd verbs
  // (agent_restart, agent_start, agent_stop, update_check, update_apply)
  // as tool calls. Non-admin agents don't get the MCP because compose
  // only bind-mounts the per-agent hostd socket for admins — wiring
  // them up would just surface ENOENT at first call.
  it("adds the hostd MCP server to .mcp.json when agent has admin: true", () => {
    const agentConfig = makeAgentConfig({
      admin: true,
      channels: { telegram: { plugin: "switchroom" } },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "admin-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "admin-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/fake/switchroom.yaml",
    );

    const mcpJson = JSON.parse(
      readFileSync(join(result.agentDir, ".mcp.json"), "utf-8"),
    );
    expect(mcpJson.mcpServers.hostd).toBeDefined();
    expect(mcpJson.mcpServers.hostd.command).toBe("/usr/local/bin/switchroom");
    expect(mcpJson.mcpServers.hostd.args).toEqual(["mcp", "hostd"]);
    expect(mcpJson.mcpServers.hostd.env.SWITCHROOM_AGENT_NAME).toBe(
      "admin-agent",
    );
  });

  it("does NOT add the hostd MCP server when agent is not admin", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "switchroom" } },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "plain-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "plain-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/fake/switchroom.yaml",
    );

    const mcpJson = JSON.parse(
      readFileSync(join(result.agentDir, ".mcp.json"), "utf-8"),
    );
    expect(mcpJson.mcpServers.hostd).toBeUndefined();
    // agent-config is always present for switchroom-plugin agents
    expect(mcpJson.mcpServers["agent-config"]).toBeDefined();
  });

  it("is idempotent — running twice with unchanged config + template = no-op", () => {
    // #1122: idempotency means "same inputs → same final state on
    // subsequent runs," NOT "user hand-edits are frozen forever." The
    // previous form of this test pinned the latter, which masked the
    // bug where profile-template changes (e.g. the conversational-
    // pacing prompt rewrite) silently bypassed every running agent
    // because CLAUDE.md was written with writeIfMissing. The fingerprint
    // -aware re-render replaces that contract; operator hand-edits are
    // backed up to `.before-rerender.<ts>` instead of being preserved
    // in-place (see scaffold.rerender-claude-md.test.ts).
    const config = makeAgentConfig({
      soul: { name: "Coach", style: "direct" },
    });

    // First scaffold
    const result1 = scaffoldAgent("idem-agent", config, tmpDir, telegramConfig);
    expect(result1.created.length).toBeGreaterThan(0);
    expect(result1.skipped.length).toBe(0);

    // Snapshot the rendered CLAUDE.md.
    const claudePath = join(result1.agentDir, "CLAUDE.md");
    const renderedContent = readFileSync(claudePath, "utf-8");

    // Second scaffold with the SAME config — should be a clean no-op.
    const result2 = scaffoldAgent("idem-agent", config, tmpDir, telegramConfig);
    expect(result2.created.length).toBe(0);
    expect(result2.skipped.length).toBeGreaterThan(0);

    // CLAUDE.md is unchanged.
    expect(readFileSync(claudePath, "utf-8")).toBe(renderedContent);
  });

  it("includes --dangerously-skip-permissions when dangerous_mode is true", () => {
    const config = makeAgentConfig({ dangerous_mode: true });
    const result = scaffoldAgent("dangerous-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("--dangerously-skip-permissions");
  });

  it("does not include --dangerously-skip-permissions when dangerous_mode is false", () => {
    const config = makeAgentConfig({ dangerous_mode: false });
    const result = scaffoldAgent("safe-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).not.toContain("--dangerously-skip-permissions");
  });

  it("never emits skipDangerousModePermissionPrompt — Claude Code ignores it at project scope", () => {
    // Regression guard: this key was emitted historically but Claude Code only
    // honors it at user/local scope, never project. autoaccept handles the prompt.
    const config = makeAgentConfig({});
    const result = scaffoldAgent("skip-default", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(settings.permissions?.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  it("never emits enabledPlugins — redundant with start.sh CLI flag pathway", () => {
    // Regression guard: plugin selection is driven by --channels / --plugin-dir
    // in profiles/_base/start.sh.hbs. The settings.json block would work but
    // duplicate state with the CLI flag and risk drift.
    const config = makeAgentConfig();
    const result = scaffoldAgent("no-enabled-plugins", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.enabledPlugins).toBeUndefined();
  });

  it("does not include switchroom-telegram MCP server in settings.json (it lives in .mcp.json)", () => {
    // The switchroom fork loads via --dangerously-load-development-channels
    // which reads from .mcp.json, not settings.json. Verify it doesn't
    // leak into settings.json.
    const config = makeAgentConfig();
    const result = scaffoldAgent("plugin-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers?.["switchroom-telegram"]).toBeUndefined();
  });

  it("writes comment in .env when bot token is unresolvable vault reference", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    // With no SWITCHROOM_VAULT_PASSPHRASE or TELEGRAM_BOT_TOKEN set, should write comment
    const origPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.TELEGRAM_BOT_TOKEN;

    try {
      const config = makeAgentConfig();
      const result = scaffoldAgent("vault-agent", config, tmpDir, vaultTelegramConfig);
      const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

      expect(envContent).toContain("# Set your bot token");
    } finally {
      if (origPassphrase !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = origPassphrase;
      if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    }
  });

  // --- M2: unresolvable vault bot-token must NOT fall back to the ambient
  //     $TELEGRAM_BOT_TOKEN, which on a multi-agent apply is another agent's
  //     token. Prior behaviour wrote agent B's token into agent A's .env.
  it("does NOT write ambient $TELEGRAM_BOT_TOKEN when a vault bot-token is unresolvable (M2)", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    const origPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    // Simulate a multi-agent apply where the outer process exported a
    // DIFFERENT agent's bot token into the environment.
    const otherAgentToken = "555000:OTHER-AGENT-TOKEN";
    process.env.TELEGRAM_BOT_TOKEN = otherAgentToken;
    try {
      const config = makeAgentConfig();
      const result = scaffoldAgent("m2-agent", config, tmpDir, vaultTelegramConfig);
      const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

      // Never the cross-agent ambient token…
      expect(envContent).not.toContain(otherAgentToken);
      // …and never any active token assignment at all — just the placeholder.
      expect(envContent).not.toMatch(/^\s*TELEGRAM_BOT_TOKEN=\S/m);
      expect(envContent).toContain("# Set your bot token");
    } finally {
      if (origPassphrase !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = origPassphrase;
      else delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
      if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  // --- M3: a placeholder .env is refreshed to the real token once the vault
  //     grant lands on a later reconcile (writeIfMissing froze it before).
  it("refreshes a placeholder .env to the real token once the vault ref resolves on reconcile (M3)", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: vaultTelegramConfig,
      agents: { "m3-agent": config },
    } as SwitchroomConfig;

    const origPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    const origVaultPath = process.env.SWITCHROOM_VAULT_PATH;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.SWITCHROOM_VAULT_PATH;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      // First scaffold: vault ungranted → placeholder frozen on disk.
      const result = scaffoldAgent("m3-agent", config, tmpDir, vaultTelegramConfig, switchroomConfig);
      const envPath = join(result.agentDir, "telegram", ".env");
      expect(readFileSync(envPath, "utf-8")).toContain("# Set your bot token");
      expect(readFileSync(envPath, "utf-8")).not.toMatch(/^\s*TELEGRAM_BOT_TOKEN=\S/m);

      // Grant lands: the operator sets the secret in the vault.
      const vaultPath = join(tmpDir, "vault.enc");
      const passphrase = "test-passphrase";
      createVault(passphrase, vaultPath);
      const realToken = "777333:VAULT-RESOLVED-TOKEN";
      setStringSecret(passphrase, vaultPath, "telegram-bot-token", realToken);
      process.env.SWITCHROOM_VAULT_PATH = vaultPath;
      process.env.SWITCHROOM_VAULT_PASSPHRASE = passphrase;

      // Later reconcile picks it up.
      reconcileAgent("m3-agent", config, tmpDir, vaultTelegramConfig, switchroomConfig);
      const refreshed = readFileSync(envPath, "utf-8");
      expect(refreshed).toBe(`TELEGRAM_BOT_TOKEN=${realToken}\n`);
    } finally {
      if (origPassphrase !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = origPassphrase;
      else delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
      if (origVaultPath !== undefined) process.env.SWITCHROOM_VAULT_PATH = origVaultPath;
      else delete process.env.SWITCHROOM_VAULT_PATH;
      if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  // --- M3 safety: a real operator-set token must never be clobbered by the
  //     reconcile refresh, even when the vault ref now resolves to something
  //     else.
  it("never clobbers a real operator-set .env token on reconcile (M3)", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: vaultTelegramConfig,
      agents: { "m3-safe-agent": config },
    } as SwitchroomConfig;

    const origPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    const origVaultPath = process.env.SWITCHROOM_VAULT_PATH;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.SWITCHROOM_VAULT_PATH;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = scaffoldAgent("m3-safe-agent", config, tmpDir, vaultTelegramConfig, switchroomConfig);
      const envPath = join(result.agentDir, "telegram", ".env");
      // Operator hand-sets a real token into the placeholder .env.
      const operatorToken = "111222:OPERATOR-SET";
      writeFileSync(envPath, `TELEGRAM_BOT_TOKEN=${operatorToken}\n`, { mode: 0o600 });

      // Vault now resolves the ref to a DIFFERENT value.
      const vaultPath = join(tmpDir, "vault.enc");
      const passphrase = "test-passphrase";
      createVault(passphrase, vaultPath);
      setStringSecret(passphrase, vaultPath, "telegram-bot-token", "999999:VAULT-DIFFERENT");
      process.env.SWITCHROOM_VAULT_PATH = vaultPath;
      process.env.SWITCHROOM_VAULT_PASSPHRASE = passphrase;

      reconcileAgent("m3-safe-agent", config, tmpDir, vaultTelegramConfig, switchroomConfig);
      // Operator's token is preserved — reconcile did not overwrite it.
      expect(readFileSync(envPath, "utf-8")).toBe(`TELEGRAM_BOT_TOKEN=${operatorToken}\n`);
    } finally {
      if (origPassphrase !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = origPassphrase;
      else delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
      if (origVaultPath !== undefined) process.env.SWITCHROOM_VAULT_PATH = origVaultPath;
      else delete process.env.SWITCHROOM_VAULT_PATH;
      if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("never clobbers an `export TELEGRAM_BOT_TOKEN=` hand-edit on reconcile (M3)", () => {
    const vaultTelegramConfig: TelegramConfig = {
      bot_token: "vault:telegram-bot-token",
      forum_chat_id: "-1001234567890",
    };
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: vaultTelegramConfig,
      agents: { "m3-export-agent": config },
    } as SwitchroomConfig;

    const origPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    const origVaultPath = process.env.SWITCHROOM_VAULT_PATH;
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.SWITCHROOM_VAULT_PATH;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = scaffoldAgent("m3-export-agent", config, tmpDir, vaultTelegramConfig, switchroomConfig);
      const envPath = join(result.agentDir, "telegram", ".env");
      // Operator hand-edits with shell `export` syntax.
      const operatorLine = "export TELEGRAM_BOT_TOKEN=111222:OPERATOR-EXPORT\n";
      writeFileSync(envPath, operatorLine, { mode: 0o600 });

      const vaultPath = join(tmpDir, "vault.enc");
      const passphrase = "test-passphrase";
      createVault(passphrase, vaultPath);
      setStringSecret(passphrase, vaultPath, "telegram-bot-token", "999999:VAULT-DIFFERENT");
      process.env.SWITCHROOM_VAULT_PATH = vaultPath;
      process.env.SWITCHROOM_VAULT_PASSPHRASE = passphrase;

      reconcileAgent("m3-export-agent", config, tmpDir, vaultTelegramConfig, switchroomConfig);
      // The `export`-prefixed real token is a real token, not the placeholder.
      expect(readFileSync(envPath, "utf-8")).toBe(operatorLine);
    } finally {
      if (origPassphrase !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = origPassphrase;
      else delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
      if (origVaultPath !== undefined) process.env.SWITCHROOM_VAULT_PATH = origVaultPath;
      else delete process.env.SWITCHROOM_VAULT_PATH;
      if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("uses per-agent bot token when provided", () => {
    const config = makeAgentConfig({ bot_token: "999888:AGENT-SPECIFIC" });
    const result = scaffoldAgent("agent-token", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=999888:AGENT-SPECIFIC");
  });

  it("falls back to global bot token when no per-agent token", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("global-token", config, tmpDir, telegramConfig);
    const envContent = readFileSync(join(result.agentDir, "telegram", ".env"), "utf-8");

    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=123456:ABC-DEF");
  });

  it("creates plugin directories during scaffolding", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("plugin-dir-agent", config, tmpDir, telegramConfig);

    expect(existsSync(join(result.agentDir, ".claude", "plugins", "marketplaces"))).toBe(true);
  });

  it("returns correct agentDir path", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("path-check", config, tmpDir, telegramConfig);

    expect(result.agentDir).toBe(join(tmpDir, "path-check"));
  });

  it("injects Hindsight MCP config when memory backend is hindsight", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "ollama", docker_service: true },
      },
      agents: { "memory-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "memory-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers).toBeDefined();
    expect(settings.mcpServers.hindsight).toBeDefined();
    // Default transport is the lazy-connect stdio shim (startup-resilient).
    expect(settings.mcpServers.hindsight.type).toBe("stdio");
    expect(settings.mcpServers.hindsight.args).toEqual(["hindsight-mcp-shim"]);
    expect(settings.mcpServers.hindsight.env.HINDSIGHT_MCP_URL).toBe("http://127.0.0.1:18888/mcp/");
    expect(settings.mcpServers.hindsight.env.HINDSIGHT_BANK_ID).toBe("memory-agent");
  });

  it("respects memory.config.url override for Hindsight MCP", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: {
          provider: "ollama",
          docker_service: true,
          url: "http://localhost:18888/mcp/",
        },
      },
      agents: { "memory-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "memory-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.mcpServers.hindsight.env.HINDSIGHT_MCP_URL).toBe("http://localhost:18888/mcp/");
  });

  it("seeds profile workspace/ files into agent's workspace/ directory", () => {
    const config = makeAgentConfig({
      soul: { name: "Test Agent", emoji: "\ud83e\udd16" },
    });
    const result = scaffoldAgent("ws-agent", config, tmpDir, telegramConfig);

    // Default profile ships workspace/{AGENTS,USER,IDENTITY,TOOLS,MEMORY}.md.hbs
    const workspaceDir = join(result.agentDir, "workspace");
    expect(existsSync(workspaceDir)).toBe(true);
    expect(existsSync(join(workspaceDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "USER.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "TOOLS.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "memory"))).toBe(true);

    // .hbs templates must have been rendered (not copied raw) — the file
    // must NOT contain handlebars syntax.
    const agents = readFileSync(join(workspaceDir, "AGENTS.md"), "utf-8");
    expect(agents).not.toContain("{{");
    expect(agents).toContain("AGENTS.md");

    // IDENTITY.md should include the agent's soul name (template context).
    const identity = readFileSync(join(workspaceDir, "IDENTITY.md"), "utf-8");
    expect(identity).toContain("Test Agent");

    // Source .hbs file must not appear in agent dir.
    expect(existsSync(join(workspaceDir, "AGENTS.md.hbs"))).toBe(false);
  });

  it("memory.file: false gates the workspace MEMORY.md seed (hindsight-native), leaving siblings intact", () => {
    const config = makeAgentConfig({ memory: { file: false } as AgentConfig["memory"] });
    const result = scaffoldAgent("hindsight-native-agent", config, tmpDir, telegramConfig);
    const workspaceDir = join(result.agentDir, "workspace");

    // The curated MEMORY.md must NOT be seeded — so a migration delete sticks
    // across reconcile instead of being re-created as an empty template.
    expect(existsSync(join(workspaceDir, "MEMORY.md"))).toBe(false);

    // Every OTHER bootstrap file is unaffected by the gate.
    expect(existsSync(join(workspaceDir, "USER.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, "SOUL.md"))).toBe(true);

    // Default (file omitted) still seeds MEMORY.md — gate is opt-in only.
    const def = scaffoldAgent("file-default-agent", makeAgentConfig({}), tmpDir, telegramConfig);
    expect(existsSync(join(def.agentDir, "workspace", "MEMORY.md"))).toBe(true);
  });

  it("memory.file: false makes a deleted MEMORY.md stick across reconcile (the migration scenario)", () => {
    // 1. Normal agent — MEMORY.md is seeded.
    const normal = makeAgentConfig({});
    const normalSc: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "mig-agent": normal },
    } as SwitchroomConfig;
    const r = scaffoldAgent("mig-agent", normal, tmpDir, telegramConfig, normalSc);
    const memPath = join(r.agentDir, "workspace", "MEMORY.md");
    expect(existsSync(memPath)).toBe(true);

    // 2. Migrate: operator deletes the file and flips memory.file: false.
    rmSync(memPath);
    const migrated = makeAgentConfig({ memory: { file: false } as AgentConfig["memory"] });
    const migratedSc: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "mig-agent": migrated },
    } as SwitchroomConfig;

    // 3. reconcile() is the path that runs on every `agent restart` / `apply`.
    //    It MUST NOT re-seed the deleted file — otherwise the migration never
    //    sticks. (This fails against an ungated reconcile call site.)
    reconcileAgent("mig-agent", migrated, tmpDir, telegramConfig, migratedSc);
    expect(existsSync(memPath)).toBe(false);
  });

  it("start.sh respects session_continuity.resume_mode in the generated script", () => {
    // handoff is now the default (no explicit resume_mode in config)
    const defaultResult = scaffoldAgent(
      "resume-default",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const defaultScript = readFileSync(join(defaultResult.agentDir, "start.sh"), "utf-8");
    expect(defaultScript).toContain('SWITCHROOM_RESUME_MODE="handoff"');
    expect(defaultScript).toContain('SWITCHROOM_RESUME_MAX_BYTES="2000000"');
    // handoff mode does NOT pass --continue
    expect(defaultScript).not.toMatch(/CONTINUE_FLAG="--continue"/);

    // explicit auto — opt-in to old behaviour
    const autoResult = scaffoldAgent(
      "resume-auto",
      makeAgentConfig({
        session_continuity: { resume_mode: "auto" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const autoScript = readFileSync(join(autoResult.agentDir, "start.sh"), "utf-8");
    expect(autoScript).toContain('SWITCHROOM_RESUME_MODE="auto"');
    // auto mode emits the size-check branch
    expect(autoScript).toMatch(/case "\$SWITCHROOM_RESUME_MODE" in/);
    expect(autoScript).toContain('CONTINUE_FLAG="--continue"');

    // explicit continue — always passes --continue (regression guard for opt-in)
    const contResult = scaffoldAgent(
      "resume-cont",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const contScript = readFileSync(join(contResult.agentDir, "start.sh"), "utf-8");
    expect(contScript).toContain('SWITCHROOM_RESUME_MODE="continue"');
    expect(contScript).toContain('CONTINUE_FLAG="--continue"');

    // explicit handoff
    const hoResult = scaffoldAgent(
      "resume-ho",
      makeAgentConfig({
        session_continuity: { resume_mode: "handoff" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const hoScript = readFileSync(join(hoResult.agentDir, "start.sh"), "utf-8");
    expect(hoScript).toContain('SWITCHROOM_RESUME_MODE="handoff"');
    // handoff mode: CONTINUE_FLAG stays empty (no --continue)
    expect(hoScript).not.toMatch(/CONTINUE_FLAG="--continue"/);

    // custom byte threshold
    const customResult = scaffoldAgent(
      "resume-custom",
      makeAgentConfig({
        session_continuity: { resume_mode: "auto", resume_max_bytes: 500_000 },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const customScript = readFileSync(
      join(customResult.agentDir, "start.sh"),
      "utf-8",
    );
    expect(customScript).toContain('SWITCHROOM_RESUME_MAX_BYTES="500000"');
  });

  it("seeds safe default tools (incl. Bash) when tools.allow is empty and dangerous_mode is off", () => {
    const config = makeAgentConfig(); // no tools, no dangerous_mode
    const result = scaffoldAgent("readonly-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow: string[] = settings.permissions.allow;
    expect(allow).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    // Bash is pre-approved for default agents: ordinary fleet agents are
    // per-container isolated, so a shell command's blast radius is the
    // sandbox. Gating it only stormed the approval UI on the first routine
    // shell call of nearly every task. This assertion fails on pre-change
    // code (Bash was deliberately excluded).
    expect(allow).toContain("Bash");
    // Edit/Write still gated by defaultMode: acceptEdits — not pre-approved.
    expect(allow).not.toContain("Edit");
    expect(allow).not.toContain("Write");
    // Network-reaching / gated tools must NOT be auto-allowed.
    expect(allow).not.toContain("WebFetch");
  });

  it("does NOT pre-approve any keep-gated tool via the default set", () => {
    // The default read-only seed must not smuggle in a hostd mutator, a
    // vault verb, a mental-model write, or Write/Edit. Guards against a
    // future careless addition to DEFAULT_READ_ONLY_PREAPPROVED_TOOLS.
    const config = makeAgentConfig(); // plain default agent
    const result = scaffoldAgent("gated-check-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow: string[] = settings.permissions.allow;
    for (const forbidden of [
      "Write",
      "Edit",
      "mcp__hostd__agent_restart",
      "mcp__hostd__agent_exec",
      "mcp__hostd__update_apply",
      "mcp__switchroom-telegram__vault_request_access",
      "mcp__hindsight__create_mental_model",
      "mcp__hindsight__update_mental_model",
    ]) {
      expect(allow).not.toContain(forbidden);
    }
    // The fleet deny entries must survive on the deny list.
    expect(settings.permissions.deny).toContain("AskUserQuestion");
  });

  it("tools.deny: [Bash] surfaces Bash on the deny list (deny wins in Claude Code)", () => {
    // Bash is seeded into the default allow set, but an operator who wants a
    // shell-free agent sets tools.deny: ["Bash"]. Claude Code resolves the
    // union with deny-always-wins, so the effective capability excludes Bash.
    // The scaffold's job is to faithfully emit the deny entry; we assert at
    // that layer (CC enforces precedence itself).
    const config = makeAgentConfig({
      tools: { allow: [], deny: ["Bash"] },
    } as Partial<AgentConfig>);
    const result = scaffoldAgent("shell-free-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.deny).toContain("Bash");
  });

  it("does not inject read-only defaults when user set explicit tools.allow", () => {
    const config = makeAgentConfig({
      tools: { allow: ["Bash"], deny: [] },
    } as Partial<AgentConfig>);
    const result = scaffoldAgent("explicit-agent", config, tmpDir, telegramConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const allow: string[] = settings.permissions.allow;
    expect(allow).toContain("Bash");
    // Read-only defaults should NOT be injected when user was explicit.
    expect(allow).not.toContain("Read");
    expect(allow).not.toContain("Grep");
  });

  it("start.sh invokes `switchroom workspace render --stable` to inject bootstrap", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("ws-start-agent", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("switchroom workspace render");
    expect(startSh).toContain("--stable");
    // The render call must happen BEFORE the final exec line so APPEND_PROMPT
    // is updated in time.
    const renderIdx = startSh.indexOf("switchroom workspace render");
    const execIdx = startSh.indexOf("exec claude");
    expect(renderIdx).toBeGreaterThan(0);
    expect(execIdx).toBeGreaterThan(renderIdx);
  });

  it("preserves user edits in workspace/ across re-scaffold", () => {
    const config = makeAgentConfig();
    const first = scaffoldAgent("edit-agent", config, tmpDir, telegramConfig);
    const agentsPath = join(first.agentDir, "workspace", "AGENTS.md");
    writeFileSync(agentsPath, "# MY CUSTOM AGENTS\nhello", "utf-8");

    // Re-scaffold — existing workspace files must NOT be overwritten.
    scaffoldAgent("edit-agent", config, tmpDir, telegramConfig);

    const after = readFileSync(agentsPath, "utf-8");
    expect(after).toBe("# MY CUSTOM AGENTS\nhello");
  });
});

describe("scaffoldAgent — docker-mode tmux supervisor preamble (v0.7.5)", () => {
  // Under v0.7 docker, the agent container's CMD is start.sh under tini
  // with no host-side tmux wrapper or ExecStartPost autoaccept. Without
  // this preamble: claude blocks forever on the dev-channels acknowledge
  // prompt (no autoaccept inside the container) and `switchroom agent
  // attach` fails (no tmux server inside the container with the expected
  // socket name). The preamble is gated on SWITCHROOM_RUNTIME=docker so
  // the systemd path is unchanged byte-for-byte.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-docker-tmux-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the SWITCHROOM_RUNTIME=docker gate at the top of start.sh", () => {
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("alice", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // Must come BEFORE the env-var setup so we re-exec into tmux before
    // doing redundant work (handoff load, hindsight wait-loop, etc).
    const preambleIdx = startSh.indexOf('"$SWITCHROOM_RUNTIME" = "docker"');
    const envIdx = startSh.indexOf('NVM_DIR="$HOME/.nvm"');
    expect(preambleIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(preambleIdx);
  });

  it("guards re-entry with the SWITCHROOM_DOCKER_TMUX_INNER marker", () => {
    // Without the inner-marker check the script would tmux-recurse
    // forever — first invocation re-execs into tmux, the inner script
    // runs again under tmux and would re-exec into another tmux, ...
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("bob", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('-z "$SWITCHROOM_DOCKER_TMUX_INNER"');
    expect(startSh).toContain("export SWITCHROOM_DOCKER_TMUX_INNER=1");
  });

  it("forks autoaccept-poll under the bash supervisor before the tmux exec", () => {
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("carol", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // Path must match the COPY target in docker/Dockerfile.agent. Both
    // sides are pinned in tests so a Dockerfile rename surfaces here.
    expect(startSh).toContain("/opt/switchroom/autoaccept-poll.js");
    // v0.7.6: autoaccept now runs under _switchroom_supervise, which
    // restarts it on crash with exponential backoff (RFC J Phase 2).
    // The supervisor line backgrounds with `&` and writes through
    // the supervisor logfile (not the bare command's stdout).
    expect(startSh).toMatch(
      /_switchroom_supervise autoaccept \/var\/log\/switchroom\/autoaccept\.log[\s\S]*?bun \/opt\/switchroom\/autoaccept-poll\.js "carol" &/,
    );
  });

  it("forks the gateway daemon under the bash supervisor (v0.7.6 P0)", () => {
    // The MCP sidecar exits immediately at boot if no gateway daemon
    // is running. v0.6 ran it as a sibling systemd unit; under v0.7
    // docker the agent container runs the daemon as an in-process
    // sidecar. Without this, claude boots fine but Telegram routing
    // is dead end-to-end.
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("eli", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // Path must match the COPY target in docker/Dockerfile.agent.
    expect(startSh).toContain(
      "/opt/switchroom/telegram-plugin/dist/gateway/gateway.js",
    );
    expect(startSh).toMatch(
      /_switchroom_supervise gateway \/var\/log\/switchroom\/gateway-supervisor\.log[\s\S]*?bun "\$_gateway_bundle" &/,
    );
  });

  it("hoists TELEGRAM_STATE_DIR into the preamble so the gateway sidecar finds it", () => {
    // The gateway looks at TELEGRAM_STATE_DIR for gateway.sock /
    // gateway.pid.json / history.db. Without setting it BEFORE the
    // sidecar fork, the gateway falls back to ~/.claude/channels/
    // telegram which the MCP sidecar isn't watching.
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("frank", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    const lines = startSh.split("\n");
    const stateDirIdx = lines.findIndex((l) =>
      l.includes(`TELEGRAM_STATE_DIR="${result.agentDir}/telegram"`),
    );
    const gatewayForkIdx = lines.findIndex((l) =>
      l.includes("_switchroom_supervise gateway"),
    );
    expect(stateDirIdx).toBeGreaterThan(0);
    expect(gatewayForkIdx).toBeGreaterThan(stateDirIdx);
  });

  it("supervisor backs off exponentially and never permanently gives up (RFC J Phase 2)", () => {
    // The old "10 restarts in 60s -> give up forever" turned a
    // routine broker recreate (which relocks the dockerized broker)
    // into a dead fleet until a human intervened — a direct
    // always-on violation (install-validation 2026-05-17 / RFC J).
    // New contract: EX_CONFIG=78 is the ONLY non-retry path; every
    // other exit backs off exponentially (capped) and retries
    // INDEFINITELY so the agent self-heals when the broker returns.
    // Reintroducing a permanent give-up must fail this test.
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("greta", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("_switchroom_supervise()");
    // EX_CONFIG=78 quarantine preserved — the only stop path.
    expect(startSh).toContain("if [ $_exit -eq 78 ]");
    expect(startSh).toContain("quarantined, not restarting");
    // Exponential backoff with a cap; no permanent give-up.
    expect(startSh).toMatch(/_delay=\$\(\(_delay \* 2\)\)/);
    expect(startSh).toMatch(/_delay -gt \$_cap/);
    expect(startSh).not.toContain("if [ $_restarts -ge 10 ]");
    expect(startSh).not.toMatch(/giving up|hit 10 restarts/i);
  });

  it("re-execs into tmux with the v0.6-systemd socket+session contract", () => {
    // src/agents/autoaccept.ts:151 hardcodes socket
    // `switchroom-${agentName}` and src/agents/lifecycle.ts:attachAgent
    // does `docker exec -it ... tmux -L switchroom-<name> attach -t <name>`.
    // Both contracts are met from the inside-the-container side here.
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("dave", config, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toMatch(/exec tmux -L "switchroom-dave"/);
    expect(startSh).toMatch(/new-session -A -s "dave"/);
  });

  it("preamble interpolates the agent name consistently across the three call sites", () => {
    // Three places interpolate `{{name}}` in the preamble: the
    // autoaccept-poll bun arg, the tmux socket name (-L), and the tmux
    // session name (-s). All three must agree — drift between them
    // would break the autoaccept contract or the attach contract.
    const a = scaffoldAgent("eve", makeAgentConfig({ topic_id: 1 }), tmpDir, telegramConfig);
    const b = scaffoldAgent("eve-2", makeAgentConfig({ topic_id: 2 }), tmpDir, telegramConfig);
    const aSh = readFileSync(join(a.agentDir, "start.sh"), "utf-8");
    const bSh = readFileSync(join(b.agentDir, "start.sh"), "utf-8");

    expect(aSh).toContain('bun /opt/switchroom/autoaccept-poll.js "eve"');
    expect(aSh).toContain('exec tmux -L "switchroom-eve"');
    expect(aSh).toContain('new-session -A -s "eve"');

    // Non-trivial name (with a hyphen) survives interpolation byte-for-byte.
    expect(bSh).toContain('bun /opt/switchroom/autoaccept-poll.js "eve-2"');
    expect(bSh).toContain('exec tmux -L "switchroom-eve-2"');
    expect(bSh).toContain('new-session -A -s "eve-2"');
  });

  it("Dockerfile.agent COPYs the autoaccept-poll bundle to the start.sh path", () => {
    // The two contracts have to stay paired: the start.sh preamble's
    // `bun /opt/switchroom/autoaccept-poll.js` invocation only resolves
    // because Dockerfile.agent COPYs the bundle into that exact path
    // at image build time. A rename in either file silently breaks
    // autoaccept, so pin both halves here.
    const dockerfile = readFileSync(
      resolve(__dirname, "..", "docker", "Dockerfile.agent"),
      "utf-8",
    );
    expect(dockerfile).toContain(
      "COPY dist/cli/autoaccept-poll.js /opt/switchroom/autoaccept-poll.js",
    );
    expect(dockerfile).toMatch(
      /chmod 0755 \/opt\/switchroom\/autoaccept-poll\.js/,
    );
  });

  it("Dockerfile.agent COPYs the telegram-plugin bundle for the gateway sidecar (v0.7.6)", () => {
    // start.sh forks `bun /opt/switchroom/telegram-plugin/dist/gateway/
    // gateway.js`. That path resolves only because Dockerfile.agent
    // bakes the plugin in. The MCP sidecar (claude-spawned) ALSO uses
    // this path via .mcp.json's `--cwd`. A rename in either side
    // breaks Telegram routing silently end-to-end.
    const dockerfile = readFileSync(
      resolve(__dirname, "..", "docker", "Dockerfile.agent"),
      "utf-8",
    );
    expect(dockerfile).toContain(
      "COPY telegram-plugin/dist /opt/switchroom/telegram-plugin/dist",
    );
    expect(dockerfile).toContain(
      "COPY telegram-plugin/start.js /opt/switchroom/telegram-plugin/start.js",
    );
    expect(dockerfile).toContain(
      "COPY telegram-plugin/package.json /opt/switchroom/telegram-plugin/package.json",
    );
  });
});

describe("scaffoldAgent — .mcp.json points at in-image paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-mcp-docker-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--cwd resolves to /opt/switchroom/telegram-plugin", () => {
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("alice", config, tmpDir, telegramConfig);
    const mcp = JSON.parse(
      readFileSync(join(result.agentDir, ".mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    const args = mcp.mcpServers["switchroom-telegram"].args;
    const cwdIdx = args.indexOf("--cwd");
    expect(cwdIdx).toBeGreaterThan(-1);
    expect(args[cwdIdx + 1]).toBe("/opt/switchroom/telegram-plugin");
  });

  it("SWITCHROOM_CLI_PATH and SWITCHROOM_CONFIG point at in-image paths", () => {
    const config = makeAgentConfig({ topic_id: 1 });
    const result = scaffoldAgent("bob", config, tmpDir, telegramConfig);
    const mcp = JSON.parse(
      readFileSync(join(result.agentDir, ".mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const env = mcp.mcpServers["switchroom-telegram"].env;
    expect(env.SWITCHROOM_CLI_PATH).toBe("/usr/local/bin/switchroom");
    expect(env.SWITCHROOM_CONFIG).toBe("/state/config/switchroom.yaml");
  });
});

describe("reconcileAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-reconcile-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Safety net: A4a/A4b tests create sibling temp profiles
    // (profiles/__test_a4{a,b}_<pid>_<ts>) and clean up in their own
    // try/finally. Sweep any orphans as belt-and-braces.
    const profilesRoot = resolve(import.meta.dirname, "../profiles");
    try {
      for (const entry of readdirSync(profilesRoot)) {
        if (/^__test_a4[ab]_\d+_\d+$/.test(entry)) {
          rmSync(join(profilesRoot, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // profiles root missing is fine — nothing to clean
    }
  });

  // Build a unique sibling profile dir under profiles/ whose contents
  // are a copy of profiles/default. Caller can mutate workspace/ inside
  // it without polluting the shared default profile (which other vitest
  // workers walk in parallel). Returns the profile name (suitable for
  // `extends:` in the agent config) and its absolute path.
  function makeTempDefaultProfile(label: string): { profileName: string; profileDir: string } {
    const profilesRoot = resolve(import.meta.dirname, "../profiles");
    const profileName = `__test_${label}_${process.pid}_${Date.now()}`;
    const profileDir = join(profilesRoot, profileName);
    cpSync(join(profilesRoot, "default"), profileDir, { recursive: true });
    return { profileName, profileDir };
  }

  function buildSwitchroomConfig(
    agentConfig: AgentConfig,
    memory?: SwitchroomConfig["memory"],
  ): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory,
      agents: { "test-agent": agentConfig },
    } as SwitchroomConfig;
  }

  it("preserves read-only tool defaults across scaffold → reconcile", () => {
    // Regression for Sprint 1 review finding #2: reconcileAgent rebuilt
    // permissions.allow without the DEFAULT_READ_ONLY_PREAPPROVED_TOOLS
    // seed, so the first reconcile after scaffold stripped Read/Grep/Glob
    // and every such tool call started popping an approval card. Both
    // paths must include the defaults when tools.allow is empty AND
    // dangerous_mode is off.
    const agentConfig = makeAgentConfig();
    const scaffolded = scaffoldAgent("rca", agentConfig, tmpDir, telegramConfig);
    const settingsBefore = JSON.parse(
      readFileSync(join(scaffolded.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settingsBefore.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    const reconciled = reconcileAgent(
      "rca",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    const settingsAfter = JSON.parse(
      readFileSync(join(reconciled.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settingsAfter.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    // Bash is part of the default seed (per-container isolation) and must
    // survive reconcile via the same shared computeDesiredPermissionAllow.
    expect(settingsAfter.permissions.allow).toContain("Bash");
    // Edit/Write stay gated by defaultMode: acceptEdits — not pre-approved.
    expect(settingsAfter.permissions.allow).not.toContain("Edit");
    expect(settingsAfter.permissions.allow).not.toContain("Write");
  });

  it("keeps read-only defaults when tools.allow=[] and dangerous_mode=off (explicit A3 regression)", () => {
    // Sprint 2 review finding A3: the existing preserves-defaults test uses
    // makeAgentConfig() which leaves `tools` and `dangerous_mode` unset, so
    // it only exercises the "fields missing" branch. If a user explicitly
    // writes `tools: { allow: [] }` with `dangerous_mode: off`, reconcile
    // must *still* merge the DEFAULT_READ_ONLY_PREAPPROVED_TOOLS seed into
    // permissions.allow — an empty user list is not a signal to strip.
    const agentConfig = makeAgentConfig({
      tools: { allow: [] },
      dangerous_mode: "off",
    } as Partial<AgentConfig>);
    const scaffolded = scaffoldAgent("a3", agentConfig, tmpDir, telegramConfig);
    const reconciled = reconcileAgent(
      "a3",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(reconciled.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    // Bash is part of the default seed and must be present via reconcile.
    // Edit/Write stay gated by defaultMode: acceptEdits with dangerous_mode=off.
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).not.toContain("Edit");
    expect(settings.permissions.allow).not.toContain("Write");
  });

  it("retracts stale enabledPlugins / skipDangerousModePermissionPrompt on reconcile (one-shot migration)", () => {
    // Pre-PR switchroom emitted both keys from settings.json.hbs to every
    // scaffolded agent. They were never tracked in _switchroomManagedRawKeys
    // (template-emitted, not settings_raw-injected), so the standard Phase-5
    // retraction loop doesn't catch them. The one-shot migration in
    // reconcileAgent must explicitly delete them.
    const agentConfig = makeAgentConfig();
    const scaffolded = scaffoldAgent("stale", agentConfig, tmpDir, telegramConfig);
    const settingsPath = join(scaffolded.agentDir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Simulate a pre-PR agent: hand-inject both stale keys.
    settings.enabledPlugins = { "telegram@claude-plugins-official": true };
    settings.skipDangerousModePermissionPrompt = true;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    reconcileAgent("stale", agentConfig, tmpDir, telegramConfig, buildSwitchroomConfig(agentConfig));
    const reconciled = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(reconciled.enabledPlugins).toBeUndefined();
    expect(reconciled.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  it("re-seeds workspace bootstrap files on reconcile (covers profile template additions)", () => {
    // Regression for Sprint 1 review finding #7: reconcileAgent did not
    // call seedWorkspaceBootstrapFiles, so new profile templates added
    // after an agent was scaffolded stayed absent until rescaffold.
    const agentConfig = makeAgentConfig();
    const scaffolded = scaffoldAgent("wsr", agentConfig, tmpDir, telegramConfig);
    const workspaceDir = join(scaffolded.agentDir, "workspace");
    expect(existsSync(join(workspaceDir, "AGENTS.md"))).toBe(true);
    // Simulate a user having deleted a workspace file — reconcile should
    // re-seed it from the profile template.
    const agentsPath = join(workspaceDir, "AGENTS.md");
    rmSync(agentsPath);
    expect(existsSync(agentsPath)).toBe(false);
    reconcileAgent(
      "wsr",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    expect(existsSync(agentsPath)).toBe(true);
    // And user edits to OTHER workspace files must survive reconcile.
    writeFileSync(join(workspaceDir, "USER.md"), "# MY EDITS", "utf-8");
    reconcileAgent(
      "wsr",
      agentConfig,
      tmpDir,
      telegramConfig,
      buildSwitchroomConfig(agentConfig),
    );
    expect(readFileSync(join(workspaceDir, "USER.md"), "utf-8")).toBe("# MY EDITS");
  });

  it("throws when the agent directory does not exist", () => {
    const agentConfig = makeAgentConfig();
    expect(() =>
      reconcileAgent(
        "missing-agent",
        agentConfig,
        tmpDir,
        telegramConfig,
        buildSwitchroomConfig(agentConfig),
      ),
    ).toThrow(/Agent directory does not exist/);
  });

  it("seeds NEW workspace templates added to the profile after scaffold (A4a regression)", () => {
    // Sprint 2 review finding A4a: when a new release ships a new
    // workspace bootstrap template, reconcile must pick it up and render
    // it into existing agents'
    // workspace directories. The earlier smoke test only proved that a
    // DELETED file gets re-seeded, not that a NEW template in the
    // profile flows through.
    //
    // We work against a sibling temp profile (profiles/__test_a4a_<pid>_<ts>),
    // not profiles/default — earlier the test wrote into the shared
    // default workspace and another vitest worker walking that dir in
    // parallel could ENOENT mid-statSync when the cleanup raced. The
    // `__` prefix keeps the temp profile out of `listAvailableProfiles`.
    const { profileName, profileDir } = makeTempDefaultProfile("a4a");
    const newTemplateName = "__A4A_TEST.md.hbs";
    const newTemplatePath = join(profileDir, "workspace", newTemplateName);
    const renderedName = newTemplateName.replace(/\.hbs$/, "");
    writeFileSync(
      newTemplatePath,
      "# Late-arriving template for {{name}}\n",
      "utf-8",
    );
    try {
      const agentConfig = makeAgentConfig({ extends: profileName });
      const scaffolded = scaffoldAgent("a4a", agentConfig, tmpDir, telegramConfig);
      // Sanity: scaffold already seeded it too… delete so we can prove
      // reconcile alone puts it back when missing. (Simulates "agent
      // scaffolded before this template existed in the profile".)
      const workspaceDir = join(scaffolded.agentDir, "workspace");
      const renderedPath = join(workspaceDir, renderedName);
      if (existsSync(renderedPath)) rmSync(renderedPath);
      expect(existsSync(renderedPath)).toBe(false);

      reconcileAgent(
        "a4a",
        agentConfig,
        tmpDir,
        telegramConfig,
        buildSwitchroomConfig(agentConfig),
      );

      expect(existsSync(renderedPath)).toBe(true);
      const contents = readFileSync(renderedPath, "utf-8");
      expect(contents).toBe("# Late-arriving template for a4a\n");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("scaffold + reconcile render workspace templates IDENTICALLY (A4b contract)", () => {
    // Sprint 2 review finding A4b: scaffoldAgent and reconcileAgent used
    // to build separate handlebars contexts for workspace template
    // rendering (scaffold ~60 keys, reconcile 7 keys). They now share
    // buildWorkspaceContext() — pin that contract with a template that
    // references a key from outside the old 7-key subset.
    //
    // Same isolation as the A4a regression test: write into a sibling
    // temp profile, not profiles/default.
    const { profileName, profileDir } = makeTempDefaultProfile("a4b");
    const templateName = "__A4B_CONTRACT.md.hbs";
    const templatePath = join(profileDir, "workspace", templateName);
    const renderedName = templateName.replace(/\.hbs$/, "");
    // Reference `{{model}}` — not in the old 7-key reconcile subset,
    // so this would render as "" on reconcile before the refactor.
    writeFileSync(
      templatePath,
      "name={{name}} soul={{soul.name}} model={{model}}\n",
      "utf-8",
    );
    try {
      const agentConfig = makeAgentConfig({
        extends: profileName,
        model: "sonnet",
        soul: { name: "TestSoul" } as unknown,
      } as Partial<AgentConfig>);

      // scaffold into dir-A
      const scaffolded = scaffoldAgent("a4b", agentConfig, tmpDir, telegramConfig);
      const scaffoldRendered = readFileSync(
        join(scaffolded.agentDir, "workspace", renderedName),
        "utf-8",
      );

      // Second agent: scaffold minimally, delete the file, then
      // reconcile to exercise the reconcile-path render.
      const scaffolded2 = scaffoldAgent("a4b", agentConfig, mkdtempSync(join(tmpdir(), "sr-a4b-")), telegramConfig);
      const workspace2 = join(scaffolded2.agentDir, "workspace");
      rmSync(join(workspace2, renderedName));
      reconcileAgent(
        "a4b",
        agentConfig,
        resolve(scaffolded2.agentDir, ".."),
        telegramConfig,
        buildSwitchroomConfig(agentConfig),
      );
      const reconcileRendered = readFileSync(
        join(workspace2, renderedName),
        "utf-8",
      );

      expect(reconcileRendered).toBe(scaffoldRendered);
      expect(reconcileRendered).toContain("model=sonnet");
      expect(reconcileRendered).toContain("soul=TestSoul");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("adds Hindsight MCP entry to settings.json after enabling memory backend", () => {
    // Step 1: scaffold an agent without memory
    const agentConfig = makeAgentConfig();
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const settingsPath = join(tmpDir, "test-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.mcpServers?.hindsight).toBeUndefined();

    // Step 2: turn on hindsight in switchroom.yaml and reconcile
    const updatedConfig = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: {
        provider: "openai",
        docker_service: true,
        url: "http://localhost:18888/mcp/",
      },
    });

    const result = reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      updatedConfig,
    );

    expect(result.changes).toContain(settingsPath);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.mcpServers.hindsight).toBeDefined();
    expect(after.mcpServers.hindsight.env.HINDSIGHT_MCP_URL).toBe("http://localhost:18888/mcp/");
    // Fix 1.2 (#2903): enumerated allow-list, NOT a wildcard/bare server grant.
    expect(after.permissions.allow).not.toContain("mcp__hindsight__*");
    expect(after.permissions.allow).not.toContain("mcp__hindsight");
    expect(after.permissions.allow).toContain("mcp__hindsight__recall");
    expect(after.permissions.allow).toContain("mcp__hindsight__retain");
    // Mental-model writes must NOT be pre-approved — they go through the propose card.
    expect(after.permissions.allow).not.toContain("mcp__hindsight__create_mental_model");
  });

  it("rewrites .mcp.json for switchroom-telegram-plugin agents to include hindsight", () => {
    const agentConfig = makeAgentConfig({ channels: { telegram: { plugin: "switchroom" } } });
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      initialConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );

    const mcpJsonPath = join(tmpDir, "test-agent", ".mcp.json");
    const before = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(before.mcpServers["switchroom-telegram"]).toBeDefined();
    expect(before.mcpServers.hindsight).toBeUndefined();

    const updatedConfig = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: {
        provider: "openai",
        docker_service: true,
        url: "http://localhost:18888/mcp/",
      },
    });

    const result = reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      updatedConfig,
      "/tmp/switchroom.yaml",
    );

    expect(result.changes).toContain(mcpJsonPath);
    const after = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(after.mcpServers["switchroom-telegram"]).toBeDefined();
    expect(after.mcpServers.hindsight).toBeDefined();
    expect(after.mcpServers.hindsight.env.HINDSIGHT_MCP_URL).toBe("http://localhost:18888/mcp/");
  });

  it("does not touch CLAUDE.md, SOUL.md, or telegram user-content files on reconcile", () => {
    // start.sh is intentionally NOT in this list — it's purely
    // template-driven (no user content) and reconcile re-renders it
    // so config changes (like enabling Hindsight or switching ports)
    // propagate without forcing a full re-scaffold.
    //
    // workspace/SOUL.md is user-owned (seed-once): reconcile must
    // preserve hand-edits, never regenerate from config.
    const agentConfig = makeAgentConfig();
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const userEditedFiles = [
      join(tmpDir, "test-agent", "CLAUDE.md"),
      join(tmpDir, "test-agent", "workspace", "SOUL.md"),
      join(tmpDir, "test-agent", "telegram", ".env"),
      join(tmpDir, "test-agent", "telegram", "access.json"),
    ];

    // Hand-edit each file with a marker the user "wrote"
    for (const f of userEditedFiles) {
      if (existsSync(f)) {
        writeFileSync(f, readFileSync(f, "utf-8") + "\n# USER EDIT\n", "utf-8");
      }
    }

    const updatedConfig = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
    });
    // preserveClaudeMd: the hand-edited CLAUDE.md without a sidecar
    // would otherwise abort the reconcile via process.exit. The test's
    // intent — verify user edits to CLAUDE.md and telegram files are
    // not silently overwritten — is satisfied by the preserve flag.
    reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      updatedConfig,
      undefined,
      { preserveClaudeMd: true },
    );

    for (const f of userEditedFiles) {
      if (existsSync(f)) {
        expect(readFileSync(f, "utf-8")).toContain("# USER EDIT");
      }
    }
  });

  it("re-renders start.sh when config drives template changes (Hindsight enable)", () => {
    const agentConfig = makeAgentConfig();
    const initialConfig = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, initialConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const before = readFileSync(startShPath, "utf-8");
    expect(before).not.toContain("HINDSIGHT_API_URL");

    // Enable Hindsight via switchroom.yaml and reconcile
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const after = readFileSync(startShPath, "utf-8");
    // Hindsight vars are now POSIX-single-quoted for shell safety
    expect(after).toContain("HINDSIGHT_API_URL='http://127.0.0.1:18888'");
    expect(after).toContain("--plugin-dir");
    expect(after).toContain(".claude/plugins/hindsight-memory");
  });

  it("start.sh waits for Hindsight API before launching Claude", () => {
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("HINDSIGHT_WAIT=0");
    // Real MCP initialize probe (a bare GET returned 200 mid-restart and let
    // a toolless session boot — 2026-07-18 clerk incident)
    expect(startSh).toContain('"method":"initialize"');
    expect(startSh).toContain("-X POST");
    expect(startSh).toContain('-H "Accept: application/json, text/event-stream"');
    expect(startSh).toContain(`grep -q '"serverInfo"'`);
    // The probe payload must be valid JSON after Handlebars rendering — a
    // template mangle should fail here, not just a substring check
    const payloadMatch = startSh.match(/-d '(\{.*\})'/);
    expect(payloadMatch).toBeTruthy();
    const payload = JSON.parse(payloadMatch![1]);
    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.method).toBe("initialize");
    expect(payload.params.protocolVersion).toBeTruthy();
    // Best-effort session cleanup after a successful probe
    expect(startSh).toContain("-X DELETE");
    expect(startSh).toContain("Mcp-Session-Id");
    // True 120s wall-clock bound (elapsed via date +%s, not iteration count);
    // boots anyway on timeout with a warning line
    expect(startSh).toContain("HINDSIGHT_WAIT -lt 120");
    expect(startSh).toContain("_hs_start=$(date +%s)");
    expect(startSh).toContain("hindsight boot gate TIMED OUT");
    expect(startSh).toContain("/mcp/");
  });

  it("start.sh omits Hindsight wait loop when memory is disabled", () => {
    const agentConfig = makeAgentConfig();
    const config = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).not.toContain("HINDSIGHT_WAIT");
  });

  it("start.sh omits HINDSIGHT_RECALL_MAX_MEMORIES when no override is set (plugin default applies)", () => {
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).not.toContain("HINDSIGHT_RECALL_MAX_MEMORIES");
  });

  it("start.sh exports HINDSIGHT_RECALL_MAX_MEMORIES when agent overrides the cap", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { max_memories: 5 } },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_MEMORIES=5");
  });

  it("start.sh exports the per-bank slot floors UNCONDITIONALLY, with the shipped default when unset", () => {
    // #3774. These two exports are deliberately NOT gated on an operator
    // override, unlike the recall knobs above. `~/.hindsight/claude-code.json`
    // survives an apply and loads AFTER the plugin's settings.json (see
    // vendor/hindsight-memory/scripts/lib/config.py `load_config`), so a
    // conditional export lets a stale hand-edited value there shadow what
    // switchroom stamps — silently, permanently, and with every test green.
    // Writing the resolved effective value on every boot makes env, which is
    // applied last, the authority. This is the same resolution mandated on
    // #3759 / #3760.
    //
    // What this pins is the OUTCOME — a rendered export carrying the effective
    // value on an agent with no override. The load-bearing half of the
    // mechanism is the `?? DEFAULT` resolution in scaffold.ts: drop it and
    // `undefined` reaches the template, the line renders as a bare
    // `...MIN_SLOTS=`, `_cast_env("", int)` returns None, the assignment is
    // skipped, and claude-code.json wins again — mutation-verified, this test
    // fails on exactly that. Re-adding a `{{#if (isNumber ...)}}` wrapper is,
    // on its own, behaviour-preserving *because* of that resolution (the value
    // is never undefined, so the guard is inert), so no test can honestly claim
    // to catch it alone; what must never regress is the pair, and a missing
    // export fails the assertions below.
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    // No override and no max_memories set → cap resolves to the switchroom
    // default of 8, and the floors DERIVE from it: own ≈ ⅓ = 3, additional
    // ≈ ⅙ = 1. (These used to be the hardcoded literals 2/1; they are now
    // cap-proportional so they track the cap instead of going stale.)
    expect(startSh).toContain("export HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS=3");
    expect(startSh).toContain("export HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS=1");
    // And never an empty assignment: `_cast_env("", int)` returns None, the
    // assignment is skipped, and claude-code.json wins again — the exact
    // failure mode this test exists to prevent.
    expect(startSh).not.toContain("export HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS=\n");
    expect(startSh).not.toContain("export HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS=\n");
  });

  it("start.sh slot-floor exports SCALE with the max_memories cap (regression: #3755 stale literals)", () => {
    // REGRESSION GUARD, env-export half. The floors were hardcoded 2/1 for the
    // old cap of 6 (#3755, 4f469b1d); raising the fleet cap 6→16 left them
    // reserving ~19% of the budget for the own bank. The defaults now derive
    // from the cap (own ≈ ⅓, additional ≈ ⅙), so a cap raise carries the floors
    // with it. This asserts the export tracks the cap — it FAILS if the floors
    // are reverted to fixed literals while the cap moves.
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { max_memories: 16 } },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_MEMORIES=16");
    // Cap 16 → own = round(16/3) = 5, additional = round(16/6) = 3.
    expect(startSh).toContain("export HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS=5");
    expect(startSh).toContain("export HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS=3");
  });

  it("start.sh exports the per-bank slot floors when the operator overrides them", () => {
    const agentConfig = makeAgentConfig({
      memory: {
        collection: "test-agent",
        recall: { own_bank_min_slots: 5, additional_bank_min_slots: 1 },
      },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS=5");
    expect(startSh).toContain("export HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS=1");
  });

  it("start.sh exports a slot floor of 0 — the reservation kill-switch, not 'unset'", () => {
    // 0 disables reservation for that side and restores the pure head-slice.
    // It must survive the `?? default` resolution rather than being replaced
    // as nullish/falsy, or an operator's rollback silently leaves the floor in
    // force.
    const agentConfig = makeAgentConfig({
      memory: {
        collection: "test-agent",
        recall: { own_bank_min_slots: 0, additional_bank_min_slots: 0 },
      },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS=0");
    expect(startSh).toContain("export HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS=0");
  });

  it("start.sh exports the #3837 score floor as OFF by default", () => {
    // The floor must ship disabled: at 0 recall.py's `_filter_by_min_score`
    // short-circuits and the injected set is unchanged fleet-wide. Exported
    // unconditionally for the same #3774 reason as the slot floors above — a
    // stale hand-edited `~/.hindsight/claude-code.json` loads AFTER
    // settings.json, so without this line an operator's leftover
    // `recallMinScore` would silently switch a recall FILTER on for an agent
    // whose switchroom.yaml never asked for one.
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    // Whole-line match, deliberately: `toContain("...MIN_SCORE=0")` also
    // matches a rendered `=0.01`, so a non-zero default would sail through it.
    expect(startSh).toContain("export HINDSIGHT_RECALL_MIN_SCORE=0\n");
    expect(startSh).toContain("export HINDSIGHT_RECALL_MIN_SCORE_SCOPE=degraded\n");
    // Never an empty assignment: `_cast_env("", float)` returns None, the
    // assignment is skipped, and claude-code.json wins again.
    expect(startSh).not.toContain("export HINDSIGHT_RECALL_MIN_SCORE=\n");
    expect(startSh).not.toContain("export HINDSIGHT_RECALL_MIN_SCORE_SCOPE=\n");
  });

  it("start.sh exports the #3837 score floor and scope when the operator opts in", () => {
    const agentConfig = makeAgentConfig({
      memory: {
        collection: "test-agent",
        recall: { min_score: 0.01, min_score_scope: "all" },
      },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_MIN_SCORE=0.01");
    expect(startSh).toContain("export HINDSIGHT_RECALL_MIN_SCORE_SCOPE=all");
  });

  it("start.sh exports HINDSIGHT_RECALL_MAX_MEMORIES=0 when operator explicitly disables the cap", () => {
    // 0 is a meaningful sentinel ("uncapped"), not the same as unset.
    // The template uses an isNumber helper specifically so 0 still
    // emits the export (vs being treated as falsy by plain {{#if}}).
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { max_memories: 0 } },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_MAX_MEMORIES=0");
  });

  // #3757 — BM25 query shaping + per-request timeout must be OPERATOR-OWNED,
  // not literals in the installed plugin. `switchroom apply` re-copies the
  // plugin from vendor/, so a hand-edit of the installed scripts/recall.py is
  // reverted on the next reconcile — which is exactly how the hardcoded 8s
  // recall timeout came back on 2026-07-27 after being patched on 07-25.
  // These tests pin the switchroom.yaml -> start.sh env path that makes the
  // values survive an apply.
  const memoryOn = (agentConfig: ReturnType<typeof makeAgentConfig>) =>
    buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });

  it("start.sh exports the #3757 recall knobs UNCONDITIONALLY, carrying the plugin defaults", () => {
    // #3774 defect class. The plugin resolves
    // DEFAULTS -> settings.json -> ~/.hindsight/claude-code.json -> env
    // (vendor/hindsight-memory/scripts/lib/config.py:437-470). A knob that is
    // not exported therefore lets a stale hand-written claude-code.json shadow
    // the shipped default, silently and with every test still green. Exporting
    // an EMPTY value does not help: `_cast_env("", int)` returns None and the
    // assignment is skipped, so empty is indistinguishable from absent. The
    // only shape that wins is a concrete value on every boot.
    const agentConfig = makeAgentConfig();
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, memoryOn(agentConfig));

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain(
      `export HINDSIGHT_RECALL_QUERY_MAX_TOKENS=${HINDSIGHT_RECALL_QUERY_MAX_TOKENS_DEFAULT}`,
    );
    expect(startSh).toContain(`export HINDSIGHT_RECALL_QUERY_STOP_TERMS='[]'`);
    // The per-bank timeout is the INNER guard of the recall envelope, so the
    // exported value is the resolved one, which derives from the shared
    // fan-out deadline rather than taking the vendor literal outright
    // (HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS_DEFAULT is its ceiling). Assert
    // against the resolver so the carrier and the envelope cannot drift apart.
    const resolved = resolveHindsightRecallTunables(undefined);
    expect(resolved.requestTimeoutSeconds).toBeLessThanOrEqual(
      HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS_DEFAULT,
    );
    expect(startSh).toContain(
      `export HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS=${resolved.requestTimeoutSeconds}`,
    );
  });

  it("the scaffold fallbacks match the hindsight plugin's own DEFAULTS", () => {
    // The unconditional export above only produces correct behaviour while the
    // value it carries IS the plugin default. Nothing at runtime reconciles the
    // two, so read the Python source and fail on drift.
    const configPy = readFileSync(
      resolve(import.meta.dirname, "..", "vendor/hindsight-memory/scripts/lib/config.py"),
      "utf-8",
    );
    const readDefault = (key: string): number => {
      const match = configPy.match(new RegExp(`"${key}":\\s*(\\d+)`));
      expect(match, `${key} not found in lib/config.py DEFAULTS`).toBeTruthy();
      return Number(match![1]);
    };
    expect(readDefault("recallQueryMaxTokens")).toBe(HINDSIGHT_RECALL_QUERY_MAX_TOKENS_DEFAULT);
    expect(readDefault("recallRequestTimeoutSeconds")).toBe(
      HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS_DEFAULT,
    );
  });

  it("start.sh exports the #3757 recall knobs from memory.recall in switchroom.yaml", () => {
    const agentConfig = makeAgentConfig({
      memory: {
        collection: "test-agent",
        recall: {
          query_max_tokens: 16,
          query_stop_terms: ["switchroom", "agent"],
          // Inside the shipped 10s fan-out deadline: a larger value is legal
          // yaml but resolves through the envelope clamp (covered by
          // scaffold.recall-tunables-survive-apply.test.ts), which would make
          // this carrier assertion measure the clamp rather than the carry.
          request_timeout_seconds: 9,
        },
      },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, memoryOn(agentConfig));

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_QUERY_MAX_TOKENS=16");
    expect(startSh).toContain("export HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS=9");
    // JSON array, single-quoted so the double quotes survive the shell.
    // Rendering is noEscape (src/agents/profiles.ts:158); if that ever
    // changed, `&quot;` would reach the plugin as literal text and the list
    // would silently parse as empty, so assert the rendered bytes.
    expect(startSh).toContain(
      `export HINDSIGHT_RECALL_QUERY_STOP_TERMS='["switchroom","agent"]'`,
    );
  });

  it("start.sh exports HINDSIGHT_RECALL_QUERY_MAX_TOKENS=0 when the operator disables shaping", () => {
    // 0 is the rollback lever ("send the query unshaped"). The export is
    // unconditional, so the only thing that can break this is a `??`/`||`
    // slip in the scaffold turning 0 back into the default.
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { query_max_tokens: 0 } },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, memoryOn(agentConfig));

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_QUERY_MAX_TOKENS=0");
  });

  it("start.sh exports an empty JSON array for HINDSIGHT_RECALL_QUERY_STOP_TERMS", () => {
    // `[]` is a real value that `_cast_env` parses and assigns, so the env
    // still beats a stale claude-code.json. Omitting the export would not.
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { query_stop_terms: [] } },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, memoryOn(agentConfig));

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain(`export HINDSIGHT_RECALL_QUERY_STOP_TERMS='[]'`);
  });

  it("start.sh does NOT export HINDSIGHT_RECALL_CACHE_TTL_SECS by default (v0.13.22 — 0% measured hit rate)", () => {
    // The 2026-05-24 audit measured 0% cache hit rate across 430+
    // Telegram turns: the cache key is (session_id, prompt, bank,
    // extra_banks) and Telegram inbounds are always unique prompts.
    // The unconditional default-600s export was removed in v0.13.22 to
    // avoid advertising a knob that doesn't help the dominant workload.
    // Operators who run Claude Code interactively (where prompt-repeat
    // happens) can still opt in via memory.recall.cache_ttl_secs in
    // switchroom.yaml — that path is exercised by the "respects an
    // operator override" test below.
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).not.toContain("export HINDSIGHT_RECALL_CACHE_TTL_SECS");
  });

  it("start.sh respects an operator override of memory.recall.cache_ttl_secs", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { cache_ttl_secs: 300 } },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_CACHE_TTL_SECS=300");
    expect(startSh).not.toContain("export HINDSIGHT_RECALL_CACHE_TTL_SECS=600");
  });

  it("start.sh exports HINDSIGHT_RECALL_CACHE_TTL_SECS=0 to disable caching for an agent", () => {
    // 0 is a meaningful sentinel ("disabled") — recall.py treats it as off.
    const agentConfig = makeAgentConfig({
      memory: { collection: "test-agent", recall: { cache_ttl_secs: 0 } },
    });
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
      config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const startSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");
    expect(startSh).toContain("export HINDSIGHT_RECALL_CACHE_TTL_SECS=0");
  });

  it("returns no changes when settings already match", () => {
    const agentConfig = makeAgentConfig();
    const config = buildSwitchroomConfig(agentConfig);
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);

    // First reconcile may apply scaffold->reconcile drift (template
    // additions or migrations that landed after the agent was scaffolded).
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, config);
    // Second should be a no-op
    const result = reconcileAgent(
      "test-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      config,
    );
    expect(result.changes).toEqual([]);
  });

  it("removes hindsight MCP entry when backend is disabled", () => {
    const agentConfig = makeAgentConfig();
    const withMemory = buildSwitchroomConfig(agentConfig, {
      backend: "hindsight",
      shared_collection: "shared",
    });
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const settingsPath = join(tmpDir, "test-agent", ".claude", "settings.json");
    const beforeReconcile = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(beforeReconcile.permissions.allow).toContain("mcp__hindsight__recall");

    // Reconcile against a config with backend=none
    const withoutMemory = buildSwitchroomConfig(agentConfig, {
      backend: "none",
      shared_collection: "shared",
    });
    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, withoutMemory);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions.allow).not.toContain("mcp__hindsight__recall");
    expect(after.mcpServers.hindsight).toBeUndefined();
  });
});

describe("installHindsightPlugin", () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-plugin-"));
    agentDir = join(tmpDir, "agent");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when memory backend is not hindsight", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "none", shared_collection: "shared" },
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;
    expect(installHindsightPlugin("agent", agentDir, config)).toBeNull();
  });

  it("returns null when agent has memory.auto_recall: false", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: {
        agent: {
          extends: "default",
          topic_name: "x",
          schedule: [],
          memory: { collection: "general", auto_recall: false, isolation: "default" },
        },
      },
    } as SwitchroomConfig;
    expect(installHindsightPlugin("agent", agentDir, config)).toBeNull();
  });

  it("copies the vendored plugin tree and returns metadata when configured", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: {
        agent: {
          extends: "default",
          topic_name: "x",
          schedule: [],
          memory: { collection: "general", auto_recall: true, isolation: "default" },
        },
      },
    } as SwitchroomConfig;
    const result = installHindsightPlugin("agent", agentDir, config);
    expect(result).not.toBeNull();
    expect(result!.pluginDir).toBe(join(agentDir, ".claude", "plugins", "hindsight-memory"));
    expect(result!.bankId).toBe("general");
    expect(result!.apiBaseUrl).toBe("http://127.0.0.1:18888");
    // Plugin manifest copied
    expect(existsSync(join(result!.pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    // Hook script copied
    expect(existsSync(join(result!.pluginDir, "scripts", "recall.py"))).toBe(true);
    expect(existsSync(join(result!.pluginDir, "scripts", "retain.py"))).toBe(true);
    // #2848 Stage C — deterministic correction-capture Stop verify hook.
    expect(existsSync(join(result!.pluginDir, "scripts", "directive_verify.py"))).toBe(true);
    expect(existsSync(join(result!.pluginDir, "hooks", "hooks.json"))).toBe(true);
    // The Stop event wires BOTH the directive-capture verify (sync, blocking)
    // and retain (async). Verify is registered so a durable correction the
    // model dropped gets a single re-prompt to persist it.
    const hooksJson = JSON.parse(
      readFileSync(join(result!.pluginDir, "hooks", "hooks.json"), "utf8"),
    );
    const stopCommands = (hooksJson.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((g) => g.hooks.map((h) => h.command))
      .join(" ");
    expect(stopCommands).toContain("directive_verify.py");
    expect(stopCommands).toContain("retain.py");
  });

  it("falls back to agent name when no explicit collection is set", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: { backend: "hindsight", shared_collection: "shared" },
      agents: { coach: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;
    mkdirSync(join(tmpDir, "coach", ".claude"), { recursive: true });
    const result = installHindsightPlugin("coach", join(tmpDir, "coach"), config);
    expect(result).not.toBeNull();
    expect(result!.bankId).toBe("coach");
  });

  it("strips the /mcp/ suffix from memory.config.url to get the REST base", () => {
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://localhost:18888/mcp/" },
      },
      agents: { agent: { extends: "default", topic_name: "x", schedule: [] } },
    } as SwitchroomConfig;
    const result = installHindsightPlugin("agent", agentDir, config);
    expect(result).not.toBeNull();
    expect(result!.apiBaseUrl).toBe("http://localhost:18888");
  });
});

describe("scaffoldAgent with global defaults cascade", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-defaults-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies defaults.tools.allow to agents that leave tools unset", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read", "Grep", "Edit"] },
      },
      agents: { "def-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "def-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Defaults flow through to permissions.allow
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("Edit");
    // #235: switchroom-mcp deprecated — its wildcard is no longer pre-approved.
    expect(settings.permissions.allow).not.toContain("mcp__switchroom__*");
  });

  it("unions defaults.tools.allow with per-agent tools.allow", () => {
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Read"], deny: [] },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read", "Grep"] },
      },
      agents: { "union-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "union-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Union contains all three
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Grep");
    expect(settings.permissions.allow).toContain("Bash");
    // Read appears once (deduped)
    const reads = (settings.permissions.allow as string[]).filter((t) => t === "Read");
    expect(reads.length).toBe(1);
  });

  it("propagates defaults.channels.telegram.plugin to scaffold path", () => {
    // When the default is set globally, an agent that doesn't mention
    // channels.telegram.plugin=switchroom still gets .mcp.json written and the
    // mcp__switchroom-telegram__* tools pre-approved.
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { channels: { telegram: { plugin: "switchroom" } } },
      agents: { "plugin-default-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "plugin-default-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );

    // .mcp.json was written (the switchroom-telegram-plugin scaffold branch)
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");
  });

  it("per-agent mcp_servers override defaults.mcp_servers by key", () => {
    const agentConfig = makeAgentConfig({
      mcp_servers: {
        linear: { type: "http", url: "https://agent.linear.example" },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        mcp_servers: {
          linear: { type: "http", url: "https://default.linear.example" },
          github: { type: "http", url: "https://default.github.example" },
        },
      },
      agents: { "mcp-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "mcp-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Agent's linear entry wins
    expect(settings.mcpServers.linear.url).toBe("https://agent.linear.example");
    // Default's github entry flows through
    expect(settings.mcpServers.github.url).toBe("https://default.github.example");
  });

  it("reconcile respects defaults cascade too", () => {
    // Scaffold with defaults.tools.allow, then reconcile after changing
    // switchroom.yaml defaults — the merged allow-list should update without
    // touching the per-agent config.
    const agentConfig = makeAgentConfig();
    const initial: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: { tools: { allow: ["Read"] } },
      agents: { "rec-agent": agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("rec-agent", agentConfig, tmpDir, telegramConfig, initial);

    const settingsPath = join(tmpDir, "rec-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.permissions.allow).toContain("Read");
    expect(before.permissions.allow).not.toContain("Grep");

    // Update defaults and reconcile
    const updated: SwitchroomConfig = {
      ...initial,
      defaults: { tools: { allow: ["Read", "Grep", "Edit"] } },
    } as SwitchroomConfig;
    reconcileAgent("rec-agent", agentConfig, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions.allow).toContain("Read");
    expect(after.permissions.allow).toContain("Grep");
    expect(after.permissions.allow).toContain("Edit");
  });

  it("writes user hooks from switchroom.yaml into settings.json under hooks", () => {
    const agentConfig = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [
          { command: "/opt/audit.sh", timeout: 5 },
        ],
        Stop: [
          { command: "/opt/retain.sh", async: true },
        ],
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "hooks-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "hooks-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Native Claude Code nested shape. User's UserPromptSubmit hook +
    // switchroom-owned workspace-dynamic, timezone, and turn-pacing
    // hooks (always injected; the dynamic injects per-turn workspace
    // files, the timezone hook emits a one-line local-time
    // additionalContext, the turn-pacing hook emits the per-turn
    // conversational-pacing directive).
    expect(settings.hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          { type: "command", command: "/opt/audit.sh", timeout: 5 },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("workspace-dynamic-hook.sh"),
            timeout: 5,
          },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("timezone-hook.sh"),
            timeout: 3,
          },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("turn-pacing"),
            timeout: 3,
          },
        ],
      },
    ]);
    // User's Stop hook + switchroom-owned Stop hooks (handoff + secret-scrub
    // + silent-end-interrupt). secret-scrub and silent-end-interrupt are added
    // when the switchroom telegram plugin is used (the default in this test's
    // telegramConfig).
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          { type: "command", command: "/opt/retain.sh", async: true },
        ],
      },
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("switchroom handoff hooks-agent"),
            timeout: 35,
            async: true,
          },
          {
            type: "command",
            command: expect.stringContaining("secret-scrub-stop.mjs"),
            timeout: 15,
            async: true,
          },
          {
            type: "command",
            command: expect.stringContaining("silent-end-interrupt-stop.mjs"),
            timeout: 5,
            async: false,
          },
          {
            type: "command",
            command: expect.stringContaining("dispatch-claim-stop.mjs"),
            timeout: 5,
            async: false,
          },
          {
            type: "command",
            command: expect.stringContaining("tool-label-stop.mjs"),
            timeout: 5,
            async: true,
          },
          {
            type: "command",
            command: expect.stringContaining("self-improve-stop.mjs"),
            timeout: 10,
            async: true,
          },
        ],
      },
    ]);
  });

  it("turn-pacing directive ties the answer to the reply tool", () => {
    // Regression for the orphaned-reply visibility defect: the model
    // (esp. marko on long Postiz tasks) ended turns with plain transcript
    // text and no reply tool call, so the 30s orphaned-reply backstop had
    // to flush late. The turn-pacing directive previously said "just
    // answer" / "Stop after the answer" without binding "answer" to the
    // reply tool — the model satisfied it by writing terminal text. This
    // assertion pins the explicit reply-tool requirement so the guidance
    // can't silently regress. The directive is passed verbatim into a
    // printf hook command, so it appears literally in settings.json.
    const agentConfig = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "pacing-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "pacing-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pacingHook = (settings.hooks.UserPromptSubmit as Array<{
      hooks: Array<{ command: string }>;
    }>)
      .flatMap((g) => g.hooks)
      .find((h) => h.command.includes("turn-pacing"));
    expect(pacingHook).toBeDefined();
    const cmd = pacingHook!.command;
    expect(cmd).toContain("mcp__switchroom-telegram__reply");
    expect(cmd).toMatch(/terminal\/transcript text is NEVER delivered/);
    expect(cmd).toMatch(/No reply tool call = the user got nothing/);
  });

  it("turn-pacing directive carries the grounding + voice contract (fleet-wide)", () => {
    // Grounding: agents must validate volatile facts from a live source
    // this turn, not assert from memory/training (the stale-fact failure).
    // Voice: no sycophancy openers / AI-tell filler. Both ride the
    // per-turn directive so they reach EVERY agent (incl. custom-CLAUDE.md
    // agents) fresh each turn, not just the static fleet-invariants file.
    const agentConfig = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "ground-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "ground-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const cmd = (settings.hooks.UserPromptSubmit as Array<{
      hooks: Array<{ command: string }>;
    }>)
      .flatMap((g) => g.hooks)
      .find((h) => h.command.includes("turn-pacing"))!.command;
    // Grounding contract
    expect(cmd).toMatch(/GROUND BEFORE YOU ASSERT/);
    expect(cmd).toMatch(/checked\s+THIS turn/);
    expect(cmd).toMatch(/leads to verify, not sources/);
    // Voice contract (context-aware: skip hollow openers, keep genuine
    // acknowledgement; plain punctuation). Tone is prompt-driven; the
    // deterministic opener strip is off by default.
    expect(cmd).toMatch(/VOICE: write like a sharp colleague/);
    expect(cmd).toMatch(/Skip the hollow openers/);
    expect(cmd).toMatch(/Genuine acknowledgement is fine/);
    expect(cmd).toMatch(/plain punctuation/);
  });

  it("turn-pacing directive carries the work-labelling carrier without a reasoning-extraction hazard", () => {
    // The user must still be able to tell what the agent is doing during a
    // long silent stretch. The CARRIER changed: it is now a plain output
    // requirement (a `description` on every tool call, plus one status line
    // before a long stretch) instead of "your reasoning is hidden, so
    // re-emit it as working text".
    //
    // Why the old shape had to go: naming the model's hidden reasoning and
    // then instructing it to write that reasoning out as response text is
    // the documented trigger shape for `reasoning_extraction` refusals. A
    // refusal here can cause a silent model fallback, and an off-plan model
    // call breaches the `subscription-honest` vision pillar ("zero off-plan
    // callsites"). It also self-contradicted the reply rule ~55 lines later,
    // which bans leaving unsent transcript text for the backstop to flush.
    //
    // Guardrails that must survive: no per-tool-call narration, no raw tool
    // names, no debug dumps, still distinct from the banned placeholder ack.
    const agentConfig = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "narration-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "narration-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const cmd = (settings.hooks.UserPromptSubmit as Array<{
      hooks: Array<{ command: string }>;
    }>)
      .flatMap((g) => g.hooks)
      .find((h) => h.command.includes("turn-pacing"))!.command;
    // The work-labelling carrier is present, framed as an OUTPUT rule.
    expect(cmd).toMatch(/LABEL THE WORK AS YOU DO IT/);
    expect(cmd).toMatch(/plain-English `description`/);
    // One status line before a long stretch — the visibility outcome kept.
    expect(cmd).toMatch(/before a long stretch of work/);
    expect(cmd).toMatch(/live[\s\S]{0,40}preview/);
    // It respects the bad-list: no raw tool names, no debug dumps.
    expect(cmd).toMatch(/never raw tool names/);
    expect(cmd).toMatch(/never a debug dump/);
    // It is explicitly distinguished from the banned placeholder ack.
    expect(cmd).toMatch(/NOT the placeholder ack/);

    // NEGATIVE — the reasoning-extraction hazard. Each pattern below matched
    // the previous directive verbatim, so this block fails on the exact bug
    // it guards. The emitted text must not claim the model's reasoning is
    // hidden, nor instruct it to re-emit that reasoning as response text.
    expect(cmd).not.toMatch(/reasoning is NOT shown/);
    expect(cmd).not.toMatch(/cannot see your thinking/);
    expect(cmd).not.toMatch(/NARRATE YOUR INTENT/);
    expect(cmd).not.toMatch(/ordinary working text \(NOT a reply/);
    // Generic backstops so a reworded reintroduction still trips.
    expect(cmd).not.toMatch(/\b(?:reasoning|thinking)\b[^.]{0,80}\b(?:is|are)\s+(?:not|never)\s+(?:shown|visible|displayed)/i);
    expect(cmd).not.toMatch(/\b(?:hidden|private|internal)\s+(?:reasoning|thinking)\b/i);

    // The reply rule and the labelling rule must not contradict: the
    // directive still bans leaving unsent transcript text for the backstop,
    // and now routes the status line through a tool call instead.
    expect(cmd).toMatch(/flushes unsent text after a delay/);
    expect(cmd).toMatch(/user-facing text goes through a tool call/);
  });

  it("TELEGRAM_GUIDANCE beat 2 carries work-labelling, not reasoning narration", () => {
    // The static fleet-invariant block (shipped to every agent via
    // ~/.switchroom/fleet/switchroom-invariants.md, not just the per-turn
    // hook) carried a SECOND copy of the same hazardous shape, so it needs
    // the same fix — otherwise agents reading the static block still get
    // "your private reasoning is never shown, so write it out". Beat 2 is
    // where "go quiet and work" lives.
    //
    // NOTE: switchroom-invariants.md is generated and force-restored from
    // this constant. Fix the generator only; never hand-edit the artifact.
    const invariants = renderFleetInvariants();
    expect(invariants).toMatch(/label what you are doing/);
    expect(invariants).toMatch(/plain-English\s+`description`/);
    expect(invariants).toMatch(/Before a long silent stretch/);
    // Bad-list guardrails travel with it (no per-tool spam / raw names).
    expect(invariants).toMatch(/never raw tool names/);
    expect(invariants).toMatch(/debug dumps/);

    // NEGATIVE — same reasoning-extraction hazard, same assertions. These
    // matched the previous beat 2 verbatim.
    expect(invariants).not.toMatch(/private reasoning is never shown/);
    expect(invariants).not.toMatch(/leave a trail of intent/);
    expect(invariants).not.toMatch(/Write it as ordinary text, NOT a `reply` call/);
    expect(invariants).not.toMatch(/\b(?:reasoning|thinking)\b[^.]{0,80}\b(?:is|are)\s+(?:not|never)\s+shown/i);
    expect(invariants).not.toMatch(/\b(?:hidden|private|internal)\s+(?:reasoning|thinking)\b/i);
  });

  it("turn-pacing directive carries the decision-first turn-end shape (#2707)", () => {
    // #2707: turn-end replies render as wall-of-text on mobile. The fix
    // rides the per-turn directive so it reaches EVERY agent fresh each
    // turn: lead with the one decision, keep routine turn-ends short, one
    // idea per message, progressive disclosure (offer detail, don't dump),
    // reserve long structured replies for explicit go-deep asks.
    const agentConfig = makeAgentConfig({});
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "turnend-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "turnend-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const cmd = (settings.hooks.UserPromptSubmit as Array<{
      hooks: Array<{ command: string }>;
    }>)
      .flatMap((g) => g.hooks)
      .find((h) => h.command.includes("turn-pacing"))!.command;
    expect(cmd).toMatch(/TURN-END SHAPE/);
    expect(cmd).toMatch(/LEAD WITH THE ONE DECISION OR ANSWER/);
    expect(cmd).toMatch(/ONE IDEA PER MESSAGE/);
    expect(cmd).toMatch(/want the detail/);
    expect(cmd).toMatch(/EXPLICITLY asked to go deep/);
  });

  it("unions defaults.hooks with per-agent hooks", () => {
    const agentConfig = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [{ command: "/agent/recall.sh" }],
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        hooks: {
          UserPromptSubmit: [{ command: "/global/audit.sh", timeout: 5 }],
          PreToolUse: [{ command: "/global/policy.sh" }],
        },
      },
      agents: { "hook-union-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "hook-union-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    const ups = settings.hooks.UserPromptSubmit[0].hooks as Array<{ command: string }>;
    expect(ups.map((h) => h.command)).toEqual([
      "/global/audit.sh",
      "/agent/recall.sh",
    ]);
    // PreToolUse from defaults-only flows through
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it("writes model override into settings.json when set", () => {
    const agentConfig = makeAgentConfig({ model: "claude-opus-4-7" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "model-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "model-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.model).toBe("claude-opus-4-7");
    // And the model is baked as the $_BAKED_MODEL fallback seed and the resolved value passed to exec claude in start.sh
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("_BAKED_MODEL='claude-opus-4-7'");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
  });

  it("exports user env vars in start.sh in declaration order", () => {
    const agentConfig = makeAgentConfig({
      env: {
        SWITCHROOM_AUDIT_URL: "https://audit.example",
        LOG_LEVEL: "debug",
      },
    });
    const result = scaffoldAgent(
      "env-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Env values are POSIX-single-quoted by scaffold so shell-sensitive
    // bytes survive. See scaffold.ts userEnvQuoted.
    expect(startSh).toContain("export SWITCHROOM_AUDIT_URL='https://audit.example'");
    expect(startSh).toContain("export LOG_LEVEL='debug'");
  });

  it("renderFleetInvariants() includes the sandbox primer (epic #1850 lane 1)", async () => {
    // Closes the UX gap where agents hitting `EROFS` on a read-only mount
    // would either silently retry or echo the raw kernel error to the
    // user. The primer (top-level `SANDBOX_GUIDANCE` constant) names
    // the writable mounts + tells the agent how to respond when it hits
    // the boundary.
    //
    // PR redesigning epic #1850 moved this content from
    // `--append-system-prompt` into the fleet invariants file at
    // `~/.switchroom/fleet/switchroom-invariants.md`, loaded by Claude
    // Code native CLAUDE.md discovery via `--add-dir`. This test
    // verifies the content is in the rendered invariants file.
    const { renderFleetInvariants } = await import("../src/agents/scaffold.js");
    const out = renderFleetInvariants();
    expect(out).toContain("## Sandbox: you");
    expect(out).toContain("running in a switchroom container");
    expect(out).toContain("$HOME");
    expect(out).toContain("/state/agent/home");
    expect(out).toContain("/tmp");
    expect(out).toContain("read-only file system");
    expect(out).toContain("Operator action");
    // The fleet-wide primer's "read-only / not root / operator action"
    // framing is factually wrong for root-tier agents (compose.ts emits
    // `user: "0:0"` and skips read_only/cap_drop for them). The invariant
    // file has no per-agent variant to `{{#if root}}`-gate, so the
    // contradiction is neutralised at source with CONDITIONAL PHRASING —
    // the house pattern (cf. the context7 opt-out in LIBRARY_DOCS_GUIDANCE).
    expect(out).toContain("Root-tier exception");
    expect(out).toContain("this sandbox framing does NOT describe");
  });

  it("renderFleetInvariants() tells agents to discover vault keys, not guess", async () => {
    // Stops the most common vault failure: an agent guessing a key name
    // (`postiz/api-key`) when it already holds `marko/postiz-api-key`,
    // then burning an operator approval on a request for a non-existent
    // key. Companion to the self-correcting denied-hint in vault.ts.
    const { renderFleetInvariants } = await import("../src/agents/scaffold.js");
    const out = renderFleetInvariants();
    expect(out).toContain("Secrets in the vault");
    expect(out).toContain("switchroom vault list");
    expect(out).toContain("Never guess a key name");
    expect(out).toContain("vault_request_access");
  });

  it("renderFleetInvariants() teaches scannable formatting for multi-section replies", async () => {
    // D2: the live Telegram guidance is the TELEGRAM_GUIDANCE constant
    // rendered here (NOT profiles/_shared/telegram-style.md.hbs, which is
    // orphaned). Agents were posting flat plain-text emoji dumps before
    // kicking off sub-agents/workers. The formatting block tells them to
    // give multi-section messages bold labels + blank-line spacing, while
    // keeping conversational one-liners minimal.
    const { renderFleetInvariants } = await import("../src/agents/scaffold.js");
    const out = renderFleetInvariants();
    expect(out).toContain("### Formatting — make it scannable");
    expect(out).toContain("reads as a flat");
    expect(out).toContain("one blank line");
    // The specific D2 complaint: dispatch/worker-kickoff messages.
    expect(out).toContain("the message you post before");
    expect(out).toContain("**Dispatching**");
    // Keep the conversational-minimal half of the guidance too.
    expect(out).toContain("conversational reply needs almost no markup");
  });

  it("scaffoldAgent no longer appends the sandbox primer to system_prompt_append (moved to fleet invariants)", () => {
    // Post-#1850 the sandbox primer is in `~/.switchroom/fleet/switchroom-invariants.md`,
    // not in `--append-system-prompt`. This test guards against
    // re-introducing the duplication.
    const agentConfig = makeAgentConfig({});
    const result = scaffoldAgent(
      "sandbox-primer-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // start.sh should NOT inline the sandbox primer. The agent reads
    // it via `--add-dir ~/.switchroom/fleet` instead.
    expect(startSh).not.toContain("## Sandbox: you");
    expect(startSh).not.toContain("running in a switchroom container");
    // start.sh DOES carry the --add-dir flag pointing at the fleet dir,
    // unconditionally for every plugin path.
    expect(startSh).toContain("SR_FLEET_DIR");
    expect(startSh).toContain(".switchroom/fleet");
  });

  it("escapes system_prompt_append via POSIX single-quote wrapping", () => {
    const agentConfig = makeAgentConfig({
      system_prompt_append:
        "Always respond with 'care'. Never use double-\"quotes\". Or $VAR.",
    });
    const result = scaffoldAgent(
      "prompt-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // system_prompt_append is now assigned into a shell var
    // (APPEND_PROMPT=...) so the handoff briefing can be concatenated
    // onto it before passing to claude. The single-quote wrapping still
    // applies to the config value itself.
    expect(startSh).toContain("APPEND_PROMPT='");
    // Embedded single quote becomes '"'"'
    expect(startSh).toContain(`'"'"'care'"'"'`);
    // Dollar signs and double quotes survive untouched inside single quotes
    expect(startSh).toContain("$VAR");
    expect(startSh).toContain('double-"quotes"');
    // The exec line passes the var, quoted
    expect(startSh).toContain('--append-system-prompt "$APPEND_PROMPT"');
  });

  it("injects the Telegram formatting floor card into --append-system-prompt (scaffold path)", () => {
    // The floor card (TELEGRAM_FORMATTING_FLOOR_CARD in scaffold.ts) is the
    // model-independent formatting guidance baked into EVERY session's
    // --append-system-prompt. It must land in start.sh's APPEND_PROMPT, and it
    // must NOT depend on any per-agent config — a bare agent still gets it.
    const config = makeAgentConfig({});
    const result = scaffoldAgent(
      "floor-card-agent",
      config,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // Stable distinctive substrings pulled verbatim from the floor card (none
    // contain single quotes, so POSIX single-quote wrapping leaves them intact).
    expect(startSh).toContain("## Formatting for Telegram");
    expect(startSh).toContain("chunked safely at 32768 chars");
    expect(startSh).toContain("Every reply renders as rich Markdown");
    // The thickened card promotes the flagship rich constructs resident so the
    // model reaches for them without loading anything: the collapsible
    // `<details>` block (which replaced the falsified `**>` "expandable
    // blockquote" — wire probes 2026-08-13 showed `**>` renders as literal
    // text on the rich path), fenced-code language hints, and the "renders
    // wrong — never emit" anti-list.
    expect(startSh).toContain("collapsible \`<details>\` block");
    expect(startSh).not.toContain("expandable blockquote");
    expect(startSh).toContain("fenced code blocks ALWAYS with a language");
    expect(startSh).toContain("never emit: \`__x__\`");
    // Wire-verified natives are taught as SUPPORTED, not forbidden.
    expect(startSh).toContain("inline math \`$x^2+y^2$\`");
    expect(startSh).toContain("footnotes (\`claim[^1]\`");
    expect(startSh).toContain("task-list checkboxes");
    // Full Bot API 10.1 surface folded resident (the on-demand skill is gone,
    // so the card must carry EVERY construct with its when-to-use guidance):
    // italic, strikethrough, spoiler, ordered/nested lists, divider.
    expect(startSh).toContain("*Italic* for a light aside");
    expect(startSh).toContain("~~Strikethrough~~ only for a genuine retraction");
    expect(startSh).toContain("||text||");
    expect(startSh).toContain("A numbered list ONLY when order carries meaning");
    expect(startSh).toContain("nested sub-list only for a real hierarchy");
    expect(startSh).toContain("divider only between genuinely separate sections");
    // ==highlight== IS pipeline-supported (SUPPORTED_INLINE in render.ts, with
    // a round-trip test) — the card must recommend it AND make the anti-list
    // unambiguous that only the CARET ^...^ form is repaired away, so no agent
    // misreads "^highlight^ is repaired" as "highlighting never works".
    expect(startSh).toContain("`==highlight==` to marker-pen the one");
    expect(startSh).toContain("the unsupported caret `^highlight^` form");
    expect(startSh).toContain("`==highlight==` renders fine");
    // The on-demand telegram-formatting skill was deleted (its guidance is now
    // resident + deterministically repaired at send time). The card must carry
    // NO dangling pointer to it — a reference to a skill that no longer exists
    // is the exact ghost-reference defect this change eliminates.
    expect(startSh).not.toContain("telegram-formatting");
    // It rides the same --append-system-prompt var the operator passthrough uses.
    expect(startSh).toContain('--append-system-prompt "$APPEND_PROMPT"');
  });

  it("prepends the floor card BEFORE the operator's system_prompt_append (not overwritten)", () => {
    // When an operator sets system_prompt_append, the floor card must be
    // PREPENDED — both the floor card and the operator's text must survive,
    // proving the injection augments rather than replaces the passthrough.
    const operatorText = "OPERATOR_PASSTHROUGH_MARKER_xyz";
    const config = makeAgentConfig({ system_prompt_append: operatorText });
    const result = scaffoldAgent(
      "floor-card-plus-op-agent",
      config,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // Both present.
    expect(startSh).toContain("chunked safely at 32768 chars");
    expect(startSh).toContain(operatorText);
    // Order: the floor card's marker precedes the operator's marker (prepended).
    const floorIdx = startSh.indexOf("## Formatting for Telegram");
    const opIdx = startSh.indexOf(operatorText);
    expect(floorIdx).toBeGreaterThanOrEqual(0);
    expect(opIdx).toBeGreaterThan(floorIdx);
  });

  it("injects the Telegram formatting floor card on the reconcile path too", () => {
    // The live `switchroom apply` recreates EXISTING agents via reconcileAgent,
    // not scaffoldAgent — so the floor card must also survive the reconcile
    // re-render of start.sh (the two paths are kept in lockstep).
    const operatorText = "OPERATOR_RECONCILE_MARKER_xyz";
    const config = makeAgentConfig({ system_prompt_append: operatorText });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "floor-card-reconcile": config },
    } as SwitchroomConfig;
    scaffoldAgent("floor-card-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("floor-card-reconcile", config, tmpDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(
      join(tmpDir, "floor-card-reconcile", "start.sh"),
      "utf-8",
    );
    expect(startSh).toContain("## Formatting for Telegram");
    expect(startSh).toContain("chunked safely at 32768 chars");
    // Operator passthrough still survives the reconcile path, prepended-after.
    expect(startSh).toContain(operatorText);
    const floorIdx = startSh.indexOf("## Formatting for Telegram");
    const opIdx = startSh.indexOf(operatorText);
    expect(opIdx).toBeGreaterThan(floorIdx);
  });

  it("settings_raw deep-merges into the generated settings.json", () => {
    const agentConfig = makeAgentConfig({
      settings_raw: {
        effort: "high",
        permissions: { defaultMode: "bypassPermissions" },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "raw-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "raw-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Escape hatch wins — overrides switchroom's default permissions.defaultMode
    expect(settings.effort).toBe("high");
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    // #235: switchroom-mcp deprecated — wildcard no longer present after reconcile.
    expect(settings.permissions.allow).not.toContain("mcp__switchroom__*");
  });

  it("claude_md_raw is appended to CLAUDE.md on scaffold", () => {
    const agentConfig = makeAgentConfig({
      claude_md_raw: "## Custom addendum\n\nExtra user notes.",
    });
    const result = scaffoldAgent(
      "rawmd-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const md = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    expect(md).toContain("## Custom addendum");
    expect(md).toContain("Extra user notes.");
  });

  it("cli_args are appended to exec claude in start.sh, single-quoted", () => {
    const agentConfig = makeAgentConfig({
      cli_args: ["--effort", "high", "--add-dir", "/tmp/has space"],
    });
    const result = scaffoldAgent(
      "cliargs-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toMatch(/exec claude.*'--effort' 'high' '--add-dir' '\/tmp\/has space'/);
  });

  it("add_dirs become repeated --add-dir flags (#199)", () => {
    const agentConfig = makeAgentConfig({
      add_dirs: ["/share/collab", "/home/me/finance"],
    });
    const result = scaffoldAgent(
      "adddirs-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--add-dir '/share/collab'");
    expect(startSh).toContain("--add-dir '/home/me/finance'");
  });

  it("allowed_tools become a single quoted --allowedTools flag (#199)", () => {
    const agentConfig = makeAgentConfig({
      allowed_tools: ["Bash(git *)", "Bash(npm *)", "Edit"],
    });
    const result = scaffoldAgent(
      "allowedtools-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toMatch(/--allowedTools 'Bash\(git \*\) Bash\(npm \*\) Edit'/);
  });

  it("disallowed_tools become a single quoted --disallowedTools flag (#199)", () => {
    const agentConfig = makeAgentConfig({
      disallowed_tools: ["WebFetch", "Bash(rm *)"],
    });
    const result = scaffoldAgent(
      "disallowedtools-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toMatch(/--disallowedTools 'WebFetch Bash\(rm \*\)'/);
  });

  it("add_dirs + allowed_tools + cli_args coexist (#199)", () => {
    const agentConfig = makeAgentConfig({
      cli_args: ["--effort", "high"],
      add_dirs: ["/share"],
      allowed_tools: ["Edit"],
    });
    const result = scaffoldAgent(
      "combined-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("'--effort' 'high'");
    expect(startSh).toContain("--add-dir '/share'");
    expect(startSh).toContain("--allowedTools 'Edit'");
  });

  it("agents with no add_dirs/allowed_tools/disallowed_tools render no per-agent flags (#199)", () => {
    // Pre-#1850: this test asserted start.sh had no `--add-dir` flag
    // when the agent didn't configure any add_dirs. Post-#1850 the
    // fleet directory mount adds an unconditional `--add-dir
    // $SR_FLEET_DIR` (guarded by directory existence), so the
    // "no add-dir flags" assertion shifted from "no occurrences" to
    // "no per-agent occurrences" — i.e. no add-dir tied to a yaml
    // `add_dirs:` entry.
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "bare-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The fleet add-dir is expected and conditional on the directory
    // existing at runtime; it's emitted via the SR_FLEET_ARG shell var.
    expect(startSh).toContain("SR_FLEET_DIR");
    expect(startSh).toContain("SR_FLEET_ARG");
    // No per-agent add-dirs from yaml `add_dirs:` (since none configured).
    // Per-agent add-dirs render as literal `--add-dir '<path>'` tokens
    // inside extraCliArgs; the fleet add-dir uses an unquoted shell
    // variable `$SR_FLEET_ARG`. Distinguish by looking for literal
    // quoted `--add-dir '` which only per-agent emissions produce.
    expect(startSh).not.toContain("--add-dir '");
    expect(startSh).not.toContain("--allowedTools");
    expect(startSh).not.toContain("--disallowedTools");
  });

  it("channels.telegram.plugin: 'switchroom' writes .mcp.json for forked telegram plugin", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "switchroom" } },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "chan-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "chan-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );

    // Same .mcp.json + permissions pre-approval as the legacy path
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");

    // start.sh emits the dev-channels flag
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--dangerously-load-development-channels server:switchroom-telegram");
  });

  // sec WS8-F1 / #1416: the image-baked security-hooks plugin must be
  // loaded via --plugin-dir from the read-only in-image path on EVERY
  // claude exec variant, unconditionally (not gated on hindsight or
  // any opt-in), and never from the agent-writable scaffold dir. It's
  // the unstrippable tool-safety authority.
  it("start.sh loads the image-baked security plugin unconditionally (#1416)", () => {
    const agentConfig = makeAgentConfig(); // hindsight off by default
    const result = scaffoldAgent("secplugin-agent", agentConfig, tmpDir, telegramConfig);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Present on the active exec line even with hindsight disabled.
    expect(startSh).toContain('--plugin-dir "/opt/switchroom/security-plugin"');
    // Never the agent-writable scaffold dir for the security plugin.
    expect(startSh).not.toContain(
      `--plugin-dir "${result.agentDir}/.claude/plugins/security`,
    );
    // Boot integrity check surfaces a missing/empty image copy loudly
    // (non-fatal — the settings.json union fallback still protects).
    expect(startSh).toContain("sec WS8-F1 (#1416): security-hooks plugin artifact missing");
    expect(startSh).toContain('SR_SECPLUGIN="/opt/switchroom/security-plugin"');
    expect(startSh).toContain('"$SR_SECPLUGIN/hooks/secret-guard-pretool.mjs"');
    expect(startSh).toContain('"$SR_SECPLUGIN/hooks/drive-write-pretool.mjs"');
  });

  it("reconcile re-asserts the security --plugin-dir so it self-heals (#1416)", () => {
    const agentConfig = makeAgentConfig();
    scaffoldAgent("secplugin-reconcile", agentConfig, tmpDir, telegramConfig);
    // Simulate an older start.sh on disk that predates the security plugin.
    const startShPath = join(tmpDir, "secplugin-reconcile", "start.sh");
    writeFileSync(startShPath, "#!/bin/bash\nexec claude\n");
    reconcileAgent(
      "secplugin-reconcile",
      agentConfig,
      tmpDir,
      telegramConfig,
      {
        switchroom: { version: 1, agents_dir: tmpDir },
        telegram: telegramConfig,
        agents: { "secplugin-reconcile": agentConfig },
      } as SwitchroomConfig,
    );
    const startSh = readFileSync(startShPath, "utf-8");
    expect(startSh).toContain('--plugin-dir "/opt/switchroom/security-plugin"');
  });

  it("channels.telegram.plugin: 'official' keeps the upstream marketplace plugin", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "official" } },
    });
    const result = scaffoldAgent(
      "official-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );

    // No .mcp.json because the switchroom-telegram fork isn't loaded
    expect(existsSync(join(result.agentDir, ".mcp.json"))).toBe(false);
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("--channels plugin:telegram@claude-plugins-official");
    // #1416: the security plugin-dir is on the official variant too.
    expect(startSh).toContain('--plugin-dir "/opt/switchroom/security-plugin"');
  });

  it("channels.telegram.format and stream_throttle_ms become env vars in start.sh", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { format: "markdownv2", stream_throttle_ms: 500 } },
    });
    const result = scaffoldAgent(
      "chan-env-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("export SWITCHROOM_TG_FORMAT='markdownv2'");
    expect(startSh).toContain("export SWITCHROOM_TG_STREAM_THROTTLE_MS='500'");
  });

  it("channels.telegram.send_gate.* become SWITCHROOM_TG_SEND_GATE_* env vars", () => {
    const agentConfig = makeAgentConfig({
      channels: {
        telegram: {
          send_gate: {
            enabled: false,
            global_per_sec: 40,
            global_burst: 6,
            per_chat_per_sec: 2,
            per_chat_burst: 5,
            per_group_per_min: 30,
            per_group_burst: 4,
            edit_floor_ms: 2000,
          },
        },
      },
    });
    const result = scaffoldAgent(
      "send-gate-env-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_ENABLED='0'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_GLOBAL_PER_SEC='40'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_GLOBAL_BURST='6'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_PER_CHAT_PER_SEC='2'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_PER_CHAT_BURST='5'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_PER_GROUP_PER_MIN='30'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_PER_GROUP_BURST='4'");
    expect(startSh).toContain("export SWITCHROOM_TG_SEND_GATE_EDIT_FLOOR_MS='2000'");
  });

  it("an unset send_gate emits NO send-gate env vars (built-in defaults own it)", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { format: "html" } },
    });
    const result = scaffoldAgent(
      "no-send-gate-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).not.toContain("SWITCHROOM_TG_SEND_GATE_");
  });

  it("user env entry wins over channel-derived env default on key conflict", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { format: "markdownv2" } },
      env: { SWITCHROOM_TG_FORMAT: "text" }, // explicit override
    });
    const result = scaffoldAgent(
      "chan-env-override",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Only the user value remains
    expect(startSh).toContain("export SWITCHROOM_TG_FORMAT='text'");
    expect(startSh).not.toContain("export SWITCHROOM_TG_FORMAT='markdownv2'");
  });

  it("reconcile propagates hooks/env/model updates without touching user files", () => {
    const agentConfig = makeAgentConfig();
    const initial: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-phase2": agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("rec-phase2", agentConfig, tmpDir, telegramConfig, initial);

    // Update agent config in-place (a real user would edit switchroom.yaml)
    const updatedAgent = makeAgentConfig({
      model: "claude-sonnet-5",
      hooks: { Stop: [{ command: "/new/hook.sh", async: true }] },
      env: { NEW_VAR: "hello" },
    });
    const updated: SwitchroomConfig = {
      ...initial,
      agents: { "rec-phase2": updatedAgent },
    } as SwitchroomConfig;
    reconcileAgent("rec-phase2", updatedAgent, tmpDir, telegramConfig, updated);

    const settings = JSON.parse(
      readFileSync(join(tmpDir, "rec-phase2", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.model).toBe("claude-sonnet-5");
    expect(settings.hooks.Stop).toBeDefined();

    const startSh = readFileSync(join(tmpDir, "rec-phase2", "start.sh"), "utf-8");
    expect(startSh).toContain("export NEW_VAR='hello'");
    expect(startSh).toContain("_BAKED_MODEL='claude-sonnet-5'");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
  });

  it("is a no-op when switchroom.yaml has no defaults block (backcompat)", () => {
    // The refactor moved scaffold through mergeAgentConfig. This test
    // asserts that omitting `defaults` produces the same settings.json
    // as the pre-refactor code path would have.
    const agentConfig = makeAgentConfig({
      tools: { allow: ["Bash", "Edit"], deny: [] },
      channels: { telegram: { plugin: "switchroom" } },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "nodef-agent": agentConfig },
      // defaults intentionally omitted
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "nodef-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      "/tmp/switchroom.yaml",
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).toContain("mcp__switchroom-telegram__reply");
    // #235: switchroom-mcp deprecated — wildcard no longer pre-approved.
    expect(settings.permissions.allow).not.toContain("mcp__switchroom__*");
  });
});

describe("scaffoldAgent global skills pool", () => {
  let tmpDir: string;
  let skillsPool: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-skills-"));
    skillsPool = join(tmpDir, "skills-pool");

    // Populate a fake skills pool with three fake skills
    for (const name of ["checkin", "retain", "weekly-review"]) {
      const dir = join(skillsPool, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
    }
    // Ensure HOME expansion can't accidentally reach into the real user
    // pool — pin HOME to the tmpDir. Restore in afterEach.
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildConfig(
    agentConfig: AgentConfig,
    skillsDir?: string,
  ): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: join(tmpDir, "agents"), skills_dir: skillsDir ?? skillsPool },
      telegram: telegramConfig,
      agents: { "skills-agent": agentConfig },
    } as SwitchroomConfig;
  }

  it("symlinks declared skills from the pool into the agent skills dir", () => {
    const agentConfig = makeAgentConfig({ skills: ["checkin", "retain"] });
    const switchroomConfig = buildConfig(agentConfig);

    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    const checkinPath = join(result.agentDir, ".claude", "skills", "checkin");
    const retainPath = join(result.agentDir, ".claude", "skills", "retain");
    expect(existsSync(checkinPath)).toBe(true);
    expect(existsSync(retainPath)).toBe(true);
    // Verify they're symlinks pointing into the pool
    const { readlinkSync } = require("node:fs");
    expectRelativePoolLink(checkinPath, join(skillsPool, "checkin"));
  });

  it("unions defaults.skills with agent.skills in the symlink pass", () => {
    const agentConfig = makeAgentConfig({ skills: ["weekly-review"] });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: join(tmpDir, "agents"), skills_dir: skillsPool },
      telegram: telegramConfig,
      defaults: { skills: ["checkin", "retain"] },
      agents: { "skills-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    for (const name of ["checkin", "retain", "weekly-review"]) {
      expect(existsSync(join(result.agentDir, ".claude", "skills", name))).toBe(true);
    }
  });

  it("warns and skips missing skills without throwing", () => {
    const agentConfig = makeAgentConfig({ skills: ["checkin", "does-not-exist"] });
    const switchroomConfig = buildConfig(agentConfig);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );
    warnSpy.mockRestore();

    expect(existsSync(join(result.agentDir, ".claude", "skills", "checkin"))).toBe(true);
    expect(existsSync(join(result.agentDir, ".claude", "skills", "does-not-exist"))).toBe(false);
  });

  it("reconcile removes stale symlinks when a skill is dropped from switchroom.yaml", () => {
    const before = makeAgentConfig({ skills: ["checkin", "retain"] });
    const initial = buildConfig(before);
    const result = scaffoldAgent(
      "skills-agent",
      before,
      join(tmpDir, "agents"),
      telegramConfig,
      initial,
    );
    expect(existsSync(join(result.agentDir, ".claude", "skills", "retain"))).toBe(true);

    const after = makeAgentConfig({ skills: ["checkin"] });
    const updated = buildConfig(after);
    reconcileAgent(
      "skills-agent",
      after,
      join(tmpDir, "agents"),
      telegramConfig,
      updated,
    );

    expect(existsSync(join(result.agentDir, ".claude", "skills", "checkin"))).toBe(true);
    // retain's symlink was removed
    expect(existsSync(join(result.agentDir, ".claude", "skills", "retain"))).toBe(false);
  });

  it("does not touch template-copied skill files during stale cleanup", () => {
    // Create an agent, then manually drop a non-symlink skill file into
    // the agent's skills dir to simulate a template-contributed skill.
    // A reconcile that removes nothing from the pool must leave that
    // file in place.
    const agentConfig = makeAgentConfig({ skills: ["checkin"] });
    const switchroomConfig = buildConfig(agentConfig);
    const result = scaffoldAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    const templateSkill = join(result.agentDir, ".claude", "skills", "template-skill");
    mkdirSync(templateSkill, { recursive: true });
    writeFileSync(join(templateSkill, "SKILL.md"), "# template\n", "utf-8");

    // Reconcile with the same config
    reconcileAgent(
      "skills-agent",
      agentConfig,
      join(tmpDir, "agents"),
      telegramConfig,
      switchroomConfig,
    );

    // template-skill survives because it's a real directory, not a
    // symlink pointing into the pool
    expect(existsSync(templateSkill)).toBe(true);
  });
});

describe("phase-6b bug fixes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-phase6b-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("env values with shell-sensitive bytes are POSIX-quoted in start.sh", () => {
    // Dollar sign, backtick, double quote, embedded single quote,
    // ampersand, and newline all need to survive shell parsing.
    const agentConfig = makeAgentConfig({
      env: {
        TRICKY: "a & b $HOME `pwd` \"q\" 'x' \n two",
      },
    });
    const result = scaffoldAgent(
      "env-adversarial",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // The whole value is inside POSIX single quotes; embedded single
    // quote becomes '"'"' (close-dq"'"dq-reopen).
    expect(startSh).toContain(
      `export TRICKY='a & b $HOME \`pwd\` "q" '"'"'x'"'"' \n two'`,
    );
  });

  it("cli_args with embedded single quote and dollar sign stay intact", () => {
    const agentConfig = makeAgentConfig({
      cli_args: ["--note", "can't stop $PATH"],
    });
    const result = scaffoldAgent(
      "cli-adversarial",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain(`'--note' 'can'"'"'t stop $PATH'`);
  });

  it("reconcile drops settings.hooks events that were removed from switchroom.yaml", () => {
    const withHooks = makeAgentConfig({
      hooks: {
        UserPromptSubmit: [{ command: "/opt/a.sh" }],
        Stop: [{ command: "/opt/b.sh", async: true }],
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "drift-agent": withHooks },
    } as SwitchroomConfig;

    scaffoldAgent("drift-agent", withHooks, tmpDir, telegramConfig, switchroomConfig);
    const settingsPath = join(tmpDir, "drift-agent", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.hooks.UserPromptSubmit).toBeDefined();
    expect(before.hooks.Stop).toBeDefined();

    // User removes Stop from switchroom.yaml
    const lessHooks = makeAgentConfig({
      hooks: { UserPromptSubmit: [{ command: "/opt/a.sh" }] },
    });
    const updated: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "drift-agent": lessHooks },
    } as SwitchroomConfig;
    reconcileAgent("drift-agent", lessHooks, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.hooks.UserPromptSubmit).toBeDefined();
    // User Stop was dropped. The switchroom-owned handoff Stop (auto-added
    // when session_continuity is enabled — the default) remains.
    expect(after.hooks.Stop).toBeDefined();
    expect(JSON.stringify(after.hooks.Stop)).toContain("switchroom handoff");
    expect(JSON.stringify(after.hooks.Stop)).not.toContain("/opt/b.sh");
  });

  it("reconcile retracts settings_raw keys that were removed from switchroom.yaml", () => {
    const withRaw = makeAgentConfig({
      settings_raw: { effort: "high", customKey: "original" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "raw-drift": withRaw },
    } as SwitchroomConfig;

    scaffoldAgent("raw-drift", withRaw, tmpDir, telegramConfig, switchroomConfig);
    const settingsPath = join(tmpDir, "raw-drift", ".claude", "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(before.effort).toBe("high");
    expect(before.customKey).toBe("original");
    // Side-car tracks what was injected
    expect(before._switchroomManagedRawKeys).toEqual(["effort", "customKey"]);

    // User removes customKey from switchroom.yaml
    const lessRaw = makeAgentConfig({ settings_raw: { effort: "high" } });
    const updated: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "raw-drift": lessRaw },
    } as SwitchroomConfig;
    reconcileAgent("raw-drift", lessRaw, tmpDir, telegramConfig, updated);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.effort).toBe("high"); // still present
    expect(after.customKey).toBeUndefined(); // retracted
    expect(after._switchroomManagedRawKeys).toEqual(["effort"]);
  });

  it("reconcile retracts all settings_raw keys when the field is cleared entirely", () => {
    const withRaw = makeAgentConfig({
      settings_raw: { effort: "high", apiKeyHelper: "/bin/true" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "clear-drift": withRaw },
    } as SwitchroomConfig;
    scaffoldAgent("clear-drift", withRaw, tmpDir, telegramConfig, switchroomConfig);

    const emptyRaw = makeAgentConfig();
    const updated: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "clear-drift": emptyRaw },
    } as SwitchroomConfig;
    reconcileAgent("clear-drift", emptyRaw, tmpDir, telegramConfig, updated);

    const after = JSON.parse(
      readFileSync(join(tmpDir, "clear-drift", ".claude", "settings.json"), "utf-8"),
    );
    expect(after.effort).toBeUndefined();
    expect(after.apiKeyHelper).toBeUndefined();
    expect(after._switchroomManagedRawKeys).toBeUndefined();
  });

  it("reconcile is idempotent across two back-to-back runs with the same config", () => {
    const agentConfig = makeAgentConfig({
      hooks: { PreToolUse: [{ command: "/opt/audit.sh", timeout: 5 }] },
      env: { FOO: "bar" },
      model: "claude-sonnet-5",
      settings_raw: { effort: "high" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "idem-agent": agentConfig },
    } as SwitchroomConfig;

    scaffoldAgent("idem-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("idem-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const result = reconcileAgent(
      "idem-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    // Second reconcile is a no-op — no files touched
    expect(result.changes).toEqual([]);
  });

  it("merge does not crash when defaults has schedule but agent does not (layered cast safety)", () => {
    // Regression for the `[...merged.schedule]` crash in mergeAgentConfig
    // when resolveAgentConfig's first layer (defaults → profile) runs
    // and the profile has no schedule field at all. Covered indirectly
    // by scaffolding an agent whose cascade exercises the path.
    const agentConfig = makeAgentConfig({ extends: "coder" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        schedule: [{ cron: "0 9 * * *", prompt: "standup" }],
      },
      profiles: {
        coder: { tools: { allow: ["Bash"] } }, // no schedule
      },
      agents: { "sched-agent": agentConfig },
    } as SwitchroomConfig;

    // This call would previously TypeError via [...undefined]
    expect(() =>
      scaffoldAgent("sched-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig),
    ).not.toThrow();
  });
});

describe("scheduled task: cron-*.sh retirement (Phase 4 cron-fold-in)", () => {
  // Pre-Phase-4 each schedule entry got a self-contained bash script that
  // wrapped `claude -p`. Phase 4 (#890-#893) moved cron firing into the
  // in-container agent-scheduler → inject_inbound IPC → live session, and
  // the per-agent .sh scripts became dead weight (and a parasitic-bridge
  // hazard — #1613/#1616). These tests pin the post-retirement contract:
  //   - scaffold writes NO cron-*.sh / .source files even when schedule[] is set
  //   - reconcile DELETES stale cron-*.sh / .source files left from prior installs
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-cron-retired-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffoldAgent writes no cron-*.sh files even with schedule entries", () => {
    const agentConfig = makeAgentConfig({
      schedule: [
        { cron: "0 8 * * *", prompt: "Morning briefing" },
        { cron: "0 20 * * 0", prompt: "Weekly review" },
      ],
    });
    const result = scaffoldAgent("cron-agent", agentConfig, tmpDir, telegramConfig);

    const script0 = join(result.agentDir, "telegram", cronScriptFilename("0 8 * * *", "Morning briefing"));
    const script1 = join(result.agentDir, "telegram", cronScriptFilename("0 20 * * 0", "Weekly review"));
    expect(existsSync(script0)).toBe(false);
    expect(existsSync(script1)).toBe(false);

    // Defense-in-depth: no .source sidecars either
    const stem0 = cronUnitName("0 8 * * *", "Morning briefing");
    expect(existsSync(join(result.agentDir, "telegram", `${stem0}.source`))).toBe(false);
  });

  it("scaffoldAgent ALSO deletes stale cron-*.sh + .source from prior installs", () => {
    // Regression for the apply-side gap: `switchroom apply` calls
    // `scaffoldAgent` (not `reconcileAgentDir`) for agents it considers
    // "up to date". Without a sweep here, stale `cron-*.sh` files from
    // pre-#1799 installs persist across applies. This test pins the
    // sweep into the scaffold path.
    const agentConfig = makeAgentConfig({
      schedule: [{ cron: "0 6 * * *", prompt: "irrelevant" }],
    });
    // Pre-create a stale .sh + .source pair (simulating a v0.13.39-or-
    // older agent dir that still has the dormant `claude -p` cron
    // script on disk).
    const telegramDir = join(tmpDir, "scaffold-cleanup", "telegram");
    mkdirSync(telegramDir, { recursive: true });
    const staleStem = cronUnitName("0 6 * * *", "irrelevant");
    const staleScriptPath = join(telegramDir, `${staleStem}.sh`);
    const staleSourcePath = join(telegramDir, `${staleStem}.source`);
    writeFileSync(staleScriptPath, "#!/bin/bash\nclaude -p 'stale'\n", { mode: 0o700 });
    writeFileSync(staleSourcePath, "main\n");
    expect(existsSync(staleScriptPath)).toBe(true);
    expect(existsSync(staleSourcePath)).toBe(true);

    // Run scaffoldAgent — it should sweep the stale files even though
    // it never had any reason to write a fresh one (and never will).
    scaffoldAgent("scaffold-cleanup", agentConfig, tmpDir, telegramConfig);
    expect(existsSync(staleScriptPath)).toBe(false);
    expect(existsSync(staleSourcePath)).toBe(false);
  });

  it("reconcileAgentDir deletes stale cron-*.sh + .source from prior installs", () => {
    const agentConfig = makeAgentConfig({
      schedule: [{ cron: "0 6 * * *", prompt: "irrelevant" }],
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "cron-cleanup": agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("cron-cleanup", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    // Simulate pre-Phase-4 disk state: write a `claude -p`-bearing cron
    // script + its .source sidecar manually, then expect reconcile to
    // remove both. Filename matches the current content-hash scheme so
    // CRON_SCRIPT_BASENAME_RE catches it.
    const telegramDir = join(tmpDir, "cron-cleanup", "telegram");
    const staleStem = cronUnitName("0 6 * * *", "irrelevant");
    const staleScriptPath = join(telegramDir, `${staleStem}.sh`);
    const staleSourcePath = join(telegramDir, `${staleStem}.source`);
    writeFileSync(staleScriptPath, "#!/bin/bash\nclaude -p 'stale'\n", { mode: 0o700 });
    writeFileSync(staleSourcePath, "main\n");
    expect(existsSync(staleScriptPath)).toBe(true);
    expect(existsSync(staleSourcePath)).toBe(true);

    const result = reconcileAgent("cron-cleanup", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    expect(existsSync(staleScriptPath)).toBe(false);
    expect(existsSync(staleSourcePath)).toBe(false);
    expect(result.changes).toContain(staleScriptPath);
    expect(result.changes).toContain(staleSourcePath);
  });

  it("reconcileAgentDir deletes legacy cron-<index>.sh as well", () => {
    // Pre-Phase-D (content-hash filenames) used `cron-<int>.sh`. The
    // cleanup pass must catch both shapes via the legacy regex so a
    // long-running operator with a very old install gets the same
    // disk-state outcome.
    const agentConfig = makeAgentConfig({ schedule: [] });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "cron-legacy": agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("cron-legacy", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const telegramDir = join(tmpDir, "cron-legacy", "telegram");
    const legacyPath = join(telegramDir, "cron-0.sh");
    const legacySourcePath = join(telegramDir, "cron-0.source");
    writeFileSync(legacyPath, "#!/bin/bash\nclaude -p 'legacy'\n", { mode: 0o700 });
    writeFileSync(legacySourcePath, "main\n");

    reconcileAgent("cron-legacy", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacySourcePath)).toBe(false);
  });
});

describe("sub-agent file generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-subagents-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates .claude/agents/<name>.md from subagents config", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        worker: {
          description: "Handles implementation tasks",
          model: "sonnet",
          background: true,
          isolation: "worktree",
          maxTurns: 30,
          color: "blue",
          prompt: "You are a worker. Implement the task.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "sa-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "sa-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const mdPath = join(result.agentDir, ".claude", "agents", "worker.md");
    expect(existsSync(mdPath)).toBe(true);

    const content = readFileSync(mdPath, "utf-8");
    // Frontmatter
    expect(content).toContain("name: worker");
    expect(content).toContain("description: Handles implementation tasks");
    expect(content).toContain("model: sonnet");
    expect(content).toContain("background: true");
    expect(content).toContain("isolation: worktree");
    expect(content).toContain("maxTurns: 30");
    expect(content).toContain("color: blue");
    // Body (after frontmatter)
    expect(content).toContain("You are a worker. Implement the task.");
  });

  it("merges defaults.subagents with agent.subagents by name", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        reviewer: {
          description: "Reviews work",
          model: "sonnet",
          prompt: "Review thoroughly.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        subagents: {
          worker: {
            description: "Default worker",
            model: "sonnet",
            background: true,
            prompt: "Default worker prompt.",
          },
        },
      },
      agents: { "merge-sa": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "merge-sa",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const agentsDir = join(result.agentDir, ".claude", "agents");
    // Both sub-agents exist
    expect(existsSync(join(agentsDir, "worker.md"))).toBe(true);
    expect(existsSync(join(agentsDir, "reviewer.md"))).toBe(true);
    // Worker comes from defaults
    expect(readFileSync(join(agentsDir, "worker.md"), "utf-8")).toContain(
      "Default worker prompt.",
    );
    // Reviewer comes from agent
    expect(readFileSync(join(agentsDir, "reviewer.md"), "utf-8")).toContain(
      "Review thoroughly.",
    );
  });

  it("agent subagent overrides default subagent with same name", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        worker: {
          description: "Custom worker",
          model: "opus",
          prompt: "I am the override.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        subagents: {
          worker: {
            description: "Default worker",
            model: "sonnet",
            prompt: "I am the default.",
          },
        },
      },
      agents: { "override-sa": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "override-sa",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const content = readFileSync(
      join(result.agentDir, ".claude", "agents", "worker.md"),
      "utf-8",
    );
    expect(content).toContain("model: opus");
    expect(content).toContain("I am the override.");
    expect(content).not.toContain("I am the default.");
  });

  it("reconcile updates sub-agent files when config changes", () => {
    const initial = makeAgentConfig({
      subagents: {
        worker: {
          description: "v1 worker",
          model: "sonnet",
          prompt: "Version 1.",
        },
      },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-sa": initial },
    } as SwitchroomConfig;
    scaffoldAgent("rec-sa", initial, tmpDir, telegramConfig, switchroomConfig);

    const mdPath = join(tmpDir, "rec-sa", ".claude", "agents", "worker.md");
    expect(readFileSync(mdPath, "utf-8")).toContain("Version 1.");

    // Update subagent prompt
    const updated = makeAgentConfig({
      subagents: {
        worker: {
          description: "v2 worker",
          model: "sonnet",
          prompt: "Version 2 — improved.",
        },
      },
    });
    const updatedConfig: SwitchroomConfig = {
      ...switchroomConfig,
      agents: { "rec-sa": updated },
    } as SwitchroomConfig;
    const result = reconcileAgent(
      "rec-sa",
      updated,
      tmpDir,
      telegramConfig,
      updatedConfig,
    );

    expect(result.changes).toContain(mdPath);
    expect(readFileSync(mdPath, "utf-8")).toContain("Version 2 — improved.");
  });

  it("generates tools as comma-separated string in frontmatter", () => {
    const agentConfig = makeAgentConfig({
      subagents: {
        safe: {
          description: "Read-only agent",
          tools: ["Read", "Grep", "Glob"],
          prompt: "Read only.",
        },
      },
    });
    const result = scaffoldAgent(
      "tools-sa",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const content = readFileSync(
      join(result.agentDir, ".claude", "agents", "safe.md"),
      "utf-8",
    );
    expect(content).toContain("tools: Read, Grep, Glob");
  });
});

describe("session freshness in start.sh", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-session-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to fresh session — Hindsight recall handles continuity", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "fresh-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    expect(startSh).toContain('CONTINUE_FLAG=""');
    expect(startSh).toContain("exec claude $CONTINUE_FLAG");
    expect(startSh).not.toContain("_IDLE");
    expect(startSh).not.toContain("_TURNS");
    expect(startSh).not.toContain(".resume-next-start");
  });

  it("session.max_idle wires SWITCHROOM_SESSION_MAX_IDLE_SECS into auto-mode resume (#218)", () => {
    const agentConfig = makeAgentConfig({
      session: { max_idle: "2h" },
      session_continuity: { resume_mode: "auto" },
    });
    const result = scaffoldAgent(
      "idle-bound-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");

    // Configured max_idle is exported as the env var (2h = 7200s).
    expect(startSh).toContain('SWITCHROOM_SESSION_MAX_IDLE_SECS="7200"');
    // Auto-mode comparison consults the env var (with 7d default fallback).
    expect(startSh).toContain('"${SWITCHROOM_SESSION_MAX_IDLE_SECS:-604800}"');
    // The hard-coded 604800 from the comparison should no longer appear
    // — it now lives only in the bash-default fallback.
    expect(startSh).not.toMatch(/-lt 604800 ];/);
  });

  it("installs the Stop hook for handoff by default", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "handoff-default-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "handoff-default-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.hooks.Stop).toBeDefined();
    expect(JSON.stringify(settings.hooks.Stop)).toContain(
      "switchroom handoff handoff-default-agent",
    );
  });

  it("omits the Stop hook when session_continuity.enabled is false", () => {
    const agentConfig = makeAgentConfig({
      session_continuity: { enabled: false },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "handoff-off-agent": agentConfig },
    } as SwitchroomConfig;
    const result = scaffoldAgent(
      "handoff-off-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    // The handoff Stop hook is omitted (that's what session_continuity.enabled
    // gates). The secret-scrub Stop hook may still be present — it's gated
    // on the telegram plugin, not on session_continuity.
    const stopStr = JSON.stringify(settings.hooks.Stop ?? []);
    expect(stopStr).not.toContain("switchroom handoff");
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The session-mode detection block always references .handoff.md
    // (it's the signal that a handoff briefing was written by a prior
    // session's Stop hook); when handoff is disabled the file never
    // exists so the elif is dead code but inert. The real signal that
    // handoff is disabled is the absence of the handoff-briefing block
    // and its exported env var.
    expect(startSh).not.toContain("HANDOFF_FILE=");
  });

});

describe("secret-detect hook wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-secret-detect-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
    return {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
    } as SwitchroomConfig;
  }

  it("wires secret-guard-pretool.mjs into settings.json PreToolUse when plugin is switchroom", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    expect(pre).toBeDefined();
    const commands = pre.flatMap((e) => e.hooks).map((h) => h.command);
    expect(commands.some((c) => c.includes("secret-guard-pretool.mjs"))).toBe(true);
    // Ends in .mjs and the inner command uses bun (wrapped via run-hook.sh
    // so the line begins with `bash <wrapper>` then `<source>` then `bun ...`).
    const guardCmd = commands.find((c) => c.includes("secret-guard-pretool.mjs"))!;
    expect(guardCmd).toMatch(/run-hook\.sh/);
    // Plugin .mjs hooks run under bun (halved interpreter boot); the swap is
    // proven byte-identical to node, secret-guard included. Bundled hooks
    // (asserted elsewhere) stay on node.
    expect(guardCmd).toContain("bun ");
    expect(guardCmd).not.toContain("node ");
  });

  it("wires secret-scrub-stop.mjs into settings.json Stop when plugin is switchroom", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-stop-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-stop-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const stop = settings.hooks.Stop as Array<{ hooks: Array<{ command: string; async?: boolean }> }>;
    const scrub = stop
      .flatMap((e) => e.hooks)
      .find((h) => h.command.includes("secret-scrub-stop.mjs"));
    expect(scrub).toBeDefined();
    // Async so it can't block session shutdown.
    expect(scrub!.async).toBe(true);
  });

  it("does not wire secret-detect hooks when plugin is 'official' (upstream)", () => {
    const agentConfig = makeAgentConfig({
      channels: { telegram: { plugin: "official" } },
    });
    const result = scaffoldAgent(
      "sd-official-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-official-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const serialized = JSON.stringify(settings.hooks ?? {});
    expect(serialized).not.toContain("secret-guard-pretool.mjs");
    expect(serialized).not.toContain("secret-scrub-stop.mjs");
    // PreToolUse should be entirely absent (no user hooks configured).
    expect(settings.hooks?.PreToolUse).toBeUndefined();
  });

  it("wires tool-label-pretool.mjs and tool-label-stop.mjs when plugin is switchroom (#783)", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-tool-label-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-tool-label-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>;
    const allPre = pre.flatMap((e) => e.hooks);
    const labelHook = allPre.find((h) => h.command.includes("tool-label-pretool.mjs"));
    expect(labelHook).toBeDefined();
    // Spec requires explicit timeout: 5 (default 600 could wedge agents).
    expect(labelHook!.timeout).toBe(5);
    // Catch-all matcher: the entry that contains the label hook MUST NOT have a matcher.
    const labelEntry = pre.find((e) => e.hooks.some((h) => h.command.includes("tool-label-pretool.mjs")));
    expect(labelEntry?.matcher).toBeUndefined();

    const stop = settings.hooks.Stop as Array<{ hooks: Array<{ command: string; async?: boolean }> }>;
    const reaper = stop.flatMap((e) => e.hooks).find((h) => h.command.includes("tool-label-stop.mjs"));
    expect(reaper).toBeDefined();
    expect(reaper!.async).toBe(true);
  });

  it("wires hindsight-mental-model-pretool.mjs scoped to ^mcp__hindsight__ (#2974)", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-mm-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-mm-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{
      matcher?: string;
      hooks: Array<{ command: string; timeout?: number }>;
    }>;
    const entry = pre.find((e) =>
      e.hooks.some((h) =>
        h.command.includes("hindsight-mental-model-pretool.mjs"),
      ),
    );
    expect(entry).toBeDefined();
    // Scoped so the stdin parse cost only lands on hindsight tools.
    expect(entry!.matcher).toBe("^mcp__hindsight__");
    const hook = entry!.hooks.find((h) =>
      h.command.includes("hindsight-mental-model-pretool.mjs"),
    )!;
    // Bundled hook path + node invocation, wrapped via run-hook.sh.
    expect(hook.command).toMatch(/run-hook\.sh/);
    expect(hook.command).toContain("node ");
    expect(hook.command).toContain("/opt/switchroom/hooks/");
    // Explicit short timeout — a pure tool_name gate never needs long.
    expect(hook.timeout).toBe(10);
  });

  it("wires foreground-hog-pretool.mjs scoped to ^Bash$", () => {
    const agentConfig = makeAgentConfig();
    const result = scaffoldAgent(
      "sd-fghog-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-fghog-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{
      matcher?: string;
      hooks: Array<{ command: string; timeout?: number }>;
    }>;
    const entry = pre.find((e) =>
      e.hooks.some((h) => h.command.includes("foreground-hog-pretool.mjs")),
    );
    expect(entry).toBeDefined();
    // Scoped so the stdin parse cost only lands on Bash calls.
    expect(entry!.matcher).toBe("^Bash$");
    const hook = entry!.hooks.find((h) =>
      h.command.includes("foreground-hog-pretool.mjs"),
    )!;
    // Bundled hook path + node invocation, wrapped via run-hook.sh.
    expect(hook.command).toMatch(/run-hook\.sh/);
    expect(hook.command).toContain("node ");
    expect(hook.command).toContain("/opt/switchroom/hooks/");
    // Explicit short timeout — a pure tool_input gate never needs long.
    expect(hook.timeout).toBe(10);
  });

  it("preserves user-declared PreToolUse hooks alongside secret-guard", () => {
    const agentConfig = makeAgentConfig({
      hooks: { PreToolUse: [{ command: "/opt/audit.sh", timeout: 5 }] },
    });
    const result = scaffoldAgent(
      "sd-user-pre-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      makeConfig("sd-user-pre-agent", agentConfig),
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const pre = settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    const commands = pre.flatMap((e) => e.hooks).map((h) => h.command);
    expect(commands).toContain("/opt/audit.sh");
    expect(commands.some((c) => c.includes("secret-guard-pretool.mjs"))).toBe(true);
  });
});

describe("scaffoldAgent with inline profiles (extends cascade)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-profiles-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges inline profile between defaults and per-agent config", () => {
    const agentConfig = makeAgentConfig({ extends: "coder" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      defaults: {
        tools: { allow: ["Read"] },
        model: "claude-sonnet-5",
      },
      profiles: {
        coder: {
          tools: { allow: ["Bash", "Edit"] },
          system_prompt_append: "You write code.",
        },
      },
      agents: { "profile-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "profile-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    // Tools unioned across defaults (Read) + profile (Bash, Edit)
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Edit");
    // Model from defaults flows through profile (which doesn't set it)
    expect(settings.model).toBe("claude-sonnet-5");

    // system_prompt_append from the profile landed in start.sh
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain("You write code.");
  });

  it("per-agent fields still win over inline profile fields", () => {
    const agentConfig = makeAgentConfig({
      extends: "coder",
      model: "claude-opus-4-7",
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      profiles: {
        coder: { model: "claude-sonnet-5" },
      },
      agents: { "override-agent": agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent(
      "override-agent",
      agentConfig,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.model).toBe("claude-opus-4-7");
  });
});

describe("scaffoldAgent disables Claude Code auto-memory when Hindsight is on", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-automem-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets settings.json autoMemoryEnabled: false when Hindsight is enabled", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "general", auto_recall: true, isolation: "default" },
    });
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: { hindsight_agent: agentConfig },
    } as SwitchroomConfig;

    const result = scaffoldAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, config);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    expect(settings.autoMemoryEnabled).toBe(false);
    // Plugin tree was copied into the agent
    expect(existsSync(join(result.agentDir, ".claude", "plugins", "hindsight-memory", "scripts", "recall.py"))).toBe(true);
  });

  it("reconcile removes autoMemoryEnabled when memory backend is disabled", () => {
    const agentConfig = makeAgentConfig({
      memory: { collection: "general", auto_recall: true, isolation: "default" },
    });
    const withMemory: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      memory: {
        backend: "hindsight",
        shared_collection: "shared",
        config: { provider: "openai", docker_service: true, url: "http://127.0.0.1:18888/mcp/" },
      },
      agents: { hindsight_agent: agentConfig },
    } as SwitchroomConfig;
    scaffoldAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, withMemory);

    const withoutMemory: SwitchroomConfig = {
      ...withMemory,
      memory: { backend: "none", shared_collection: "shared" },
    } as SwitchroomConfig;
    reconcileAgent("hindsight_agent", agentConfig, tmpDir, telegramConfig, withoutMemory);

    const afterSettings = JSON.parse(
      readFileSync(join(tmpDir, "hindsight_agent", ".claude", "settings.json"), "utf-8"),
    );
    expect(afterSettings.autoMemoryEnabled).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-tpl-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders Handlebars variables", () => {
    const tplPath = join(tmpDir, "test.hbs");
    writeFileSync(tplPath, "Hello {{name}}, you are {{role}}.", "utf-8");

    const result = renderTemplate(tplPath, { name: "Alice", role: "admin" });
    expect(result).toBe("Hello Alice, you are admin.");
  });

  it("handles conditional blocks", () => {
    const tplPath = join(tmpDir, "cond.hbs");
    writeFileSync(tplPath, "{{#if active}}ON{{else}}OFF{{/if}}", "utf-8");

    expect(renderTemplate(tplPath, { active: true })).toBe("ON");
    expect(renderTemplate(tplPath, { active: false })).toBe("OFF");
  });

  it("handles each loops", () => {
    const tplPath = join(tmpDir, "loop.hbs");
    writeFileSync(tplPath, "{{#each items}}{{this}} {{/each}}", "utf-8");

    const result = renderTemplate(tplPath, { items: ["a", "b", "c"] });
    expect(result).toBe("a b c ");
  });
});

describe("installSwitchroomSkills", () => {
  let tmpDir: string;
  let fakeSkillsDir: string;
  let agentDir: string;
  // Per-describe HOME override so the real installSwitchroomSkills (which
  // resolves the bundled pool from `homedir() + /.switchroom/skills/_bundled`,
  // since PR #1173) finds a populated pool. CI hosted agents don't have
  // `~/.switchroom` set up — without this override the function early-
  // returns with "bundled skills pool dir not found" and every "scaffoldAgent
  // installs switchroom skills" assertion fails.
  let prevHome: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-builtin-skills-"));
    agentDir = join(tmpDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });

    // Stage a fake `~/.switchroom/skills/_bundled` under tmpDir and point
    // HOME at it. Covers the full universe of switchroom-* skills the
    // production resolver expects to find (universal-default trio +
    // foreman-only trio + runtime), each with a stub SKILL.md so the
    // SKILL.md-presence filter in installSwitchroomSkills accepts them.
    homeDir = join(tmpDir, "fake-home");
    const bundledPoolDir = join(homeDir, ".switchroom", "skills", "_bundled");
    mkdirSync(bundledPoolDir, { recursive: true });
    for (const name of [
      "switchroom-cli",
      "switchroom-health",
      "switchroom-runtime",
      "switchroom-status",
      "switchroom-install",
      "switchroom-manage",
      "switchroom-architecture",
    ]) {
      const d = join(bundledPoolDir, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `# ${name}\n`, "utf-8");
    }
    prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    // Legacy `fakeSkillsDir` retained for the runWithFakeSkills helper
    // tests below (those don't touch the real installSwitchroomSkills).
    fakeSkillsDir = join(tmpDir, "fake-skills");
    for (const name of ["switchroom-manage", "switchroom-health"]) {
      const d = join(fakeSkillsDir, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `# ${name}\n`, "utf-8");
    }
    // A switchroom-* dir WITHOUT a SKILL.md — should be skipped
    mkdirSync(join(fakeSkillsDir, "switchroom-noskill"), { recursive: true });
    // A non-switchroom dir WITH a SKILL.md — should also be skipped (name filter)
    const nonSwitchroom = join(fakeSkillsDir, "some-other-skill");
    mkdirSync(nonSwitchroom, { recursive: true });
    writeFileSync(join(nonSwitchroom, "SKILL.md"), "# other\n", "utf-8");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper that calls installSwitchroomSkills but overrides import.meta.dirname
   * by instead directly symlinking from our fakeSkillsDir. Since the real
   * installSwitchroomSkills resolves relative to the compiled module path, we
   * test the exported function with the real skills/ directory and separately
   * verify the logic using a thin wrapper that accepts the skills dir as
   * a parameter.
   */
  function runWithFakeSkills(targetAgentDir: string): void {
    // Manually replicate installSwitchroomSkills logic against fakeSkillsDir so
    // we can test the filtering and symlinking behaviour without touching
    // the live skills/ directory.
    const targetSkillsDir = join(targetAgentDir, ".claude", "skills");
    mkdirSync(targetSkillsDir, { recursive: true });
    for (const name of ["switchroom-manage", "switchroom-health", "switchroom-noskill", "some-other-skill"]) {
      const src = join(fakeSkillsDir, name);
      if (!existsSync(src)) continue;
      if (!name.startsWith("switchroom-")) continue;
      let stat;
      try { stat = lstatSync(src); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (!existsSync(join(src, "SKILL.md"))) continue;
      const dest = join(targetSkillsDir, name);
      try { lstatSync(dest); continue; } catch { /* not found — create */ }
      // Mirror production installSwitchroomSkills: write a RELATIVE link
      // (footgun A), computed via path.relative, not an absolute src.
      const relTarget = require("node:path").relative(dirname(dest), src);
      try { require("node:fs").symlinkSync(relTarget, dest); } catch { /* ignore */ }
    }
  }

  it("symlinks switchroom-* skills that have a SKILL.md into .claude/skills/", () => {
    runWithFakeSkills(agentDir);

    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "switchroom-manage"))).toBe(true);
    expect(existsSync(join(skillsDir, "switchroom-health"))).toBe(true);
    // Verify they are symlinks pointing into fakeSkillsDir
    expectRelativePoolLink(join(skillsDir, "switchroom-manage"), join(fakeSkillsDir, "switchroom-manage"));
    expectRelativePoolLink(join(skillsDir, "switchroom-health"), join(fakeSkillsDir, "switchroom-health"));
  });

  it("skips switchroom-* directories that have no SKILL.md", () => {
    runWithFakeSkills(agentDir);
    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "switchroom-noskill"))).toBe(false);
  });

  it("skips non-switchroom directories even when they have a SKILL.md", () => {
    runWithFakeSkills(agentDir);
    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "some-other-skill"))).toBe(false);
  });

  it("is idempotent — calling twice does not error and does not change symlinks", () => {
    runWithFakeSkills(agentDir);
    // Second call must not throw and symlinks must still be intact
    expect(() => runWithFakeSkills(agentDir)).not.toThrow();
    const skillsDir = join(agentDir, ".claude", "skills");
    expect(existsSync(join(skillsDir, "switchroom-manage"))).toBe(true);
    expectRelativePoolLink(join(skillsDir, "switchroom-manage"), join(fakeSkillsDir, "switchroom-manage"));
  });

  it("does not disturb pre-existing non-switchroom skills in .claude/skills/", () => {
    // Place a non-switchroom skill manually before running
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const existing = join(skillsDir, "my-custom-skill");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "SKILL.md"), "# custom\n", "utf-8");

    runWithFakeSkills(agentDir);

    // Custom skill is untouched
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toContain("# custom");
    // Switchroom skills were also linked
    expect(existsSync(join(skillsDir, "switchroom-manage"))).toBe(true);
  });

  it("creates .claude/skills/ if it does not exist yet", () => {
    const freshAgentDir = join(tmpDir, "fresh-agent");
    mkdirSync(freshAgentDir, { recursive: true });
    // Do NOT pre-create .claude/skills/
    runWithFakeSkills(freshAgentDir);
    expect(existsSync(join(freshAgentDir, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(freshAgentDir, ".claude", "skills", "switchroom-manage"))).toBe(true);
  });

  it("scaffoldAgent installs switchroom skills when role: foreman (#235 follow-up)", () => {
    // The real installSwitchroomSkills resolves to the project's skills/ directory.
    // Verify that after scaffoldAgent the .claude/skills directory exists and
    // contains at least one switchroom-* symlink for foreman-role agents.
    const result = scaffoldAgent(
      "auto-skills-foreman",
      makeAgentConfig({ role: "foreman" }),
      tmpDir,
      telegramConfig,
    );
    const claudeSkillsDir = join(result.agentDir, ".claude", "skills");
    expect(existsSync(claudeSkillsDir)).toBe(true);
    // At least one switchroom-* entry should be present (from the real skills/)
    const entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    const switchroomEntries = entries.filter((e: string) => e.startsWith("switchroom-"));
    expect(switchroomEntries.length).toBeGreaterThan(0);
  });

  it("scaffoldAgent does NOT install foreman-only switchroom skills for default-role assistant agents", () => {
    // Role gate split: assistant agents (the default) get the bundled-default
    // switchroom-core trio (cli/status/health) via the universal bundled-skills
    // path, but never the foreman-only operator skills (install/manage/architecture).
    const result = scaffoldAgent(
      "auto-skills-assistant",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const claudeSkillsDir = join(result.agentDir, ".claude", "skills");
    expect(existsSync(claudeSkillsDir)).toBe(true);
    const entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    const switchroomEntries = entries.filter((e: string) => e.startsWith("switchroom-")).sort();
    // Universal bundled-default quartet is present (cli + status + health
    // since v0.7; runtime added in v0.8.0 for the protocol-hoist skill).
    expect(switchroomEntries).toEqual([
      "switchroom-cli",
      "switchroom-health",
      "switchroom-runtime",
      "switchroom-status",
    ]);
    // Foreman-only trio is absent.
    for (const op of ["switchroom-install", "switchroom-manage", "switchroom-architecture"]) {
      expect(entries).not.toContain(op);
    }
  });

  it("reconcileAgent installs switchroom skills when role: foreman", () => {
    const agentConfig = makeAgentConfig({ role: "foreman" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "rec-skills-foreman": agentConfig },
    } as SwitchroomConfig;

    scaffoldAgent("rec-skills-foreman", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    // Remove .claude/skills to simulate a fresh state
    rmSync(join(tmpDir, "rec-skills-foreman", ".claude", "skills"), { recursive: true, force: true });

    reconcileAgent("rec-skills-foreman", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const claudeSkillsDir = join(tmpDir, "rec-skills-foreman", ".claude", "skills");
    expect(existsSync(claudeSkillsDir)).toBe(true);
    const entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    const switchroomEntries = entries.filter((e: string) => e.startsWith("switchroom-"));
    expect(switchroomEntries.length).toBeGreaterThan(0);
  });

  it("reconcileAgent retracts foreman-only skills when role flips foreman → assistant", () => {
    // Setup: scaffold as foreman, confirm both bundled-defaults and foreman-only
    // operator skills are present.
    const foremanCfg = makeAgentConfig({ role: "foreman" });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "role-flip": foremanCfg },
    } as SwitchroomConfig;
    scaffoldAgent("role-flip", foremanCfg, tmpDir, telegramConfig, switchroomConfig);
    const claudeSkillsDir = join(tmpDir, "role-flip", ".claude", "skills");
    let entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    // Foreman gets foreman-only operator skills...
    expect(entries).toContain("switchroom-install");
    expect(entries).toContain("switchroom-manage");
    expect(entries).toContain("switchroom-architecture");
    // ...as well as the universal bundled-default trio.
    expect(entries).toContain("switchroom-cli");

    // Flip role to assistant and reconcile — only foreman-only skills retract.
    // The bundled-default trio (cli/status/health) stays because it's universal.
    const assistantCfg = makeAgentConfig(); // role omitted = assistant default
    reconcileAgent("role-flip", assistantCfg, tmpDir, telegramConfig, {
      ...switchroomConfig,
      agents: { "role-flip": assistantCfg },
    } as SwitchroomConfig);
    entries = require("node:fs").readdirSync(claudeSkillsDir) as string[];
    for (const op of ["switchroom-install", "switchroom-manage", "switchroom-architecture"]) {
      expect(entries).not.toContain(op);
    }
    // Universal bundled-default trio stays.
    expect(entries).toContain("switchroom-cli");
    expect(entries).toContain("switchroom-status");
    expect(entries).toContain("switchroom-health");
  });
});

describe("CLAUDE.md-first workspace template (Phase 5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-claudemd-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds workspace/CLAUDE.md as a regular file with expected content", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("claudemd-fresh", config, tmpDir, telegramConfig);

    const claudeMd = join(result.agentDir, "workspace", "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    expect(lstatSync(claudeMd).isFile()).toBe(true);
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(false);

    const content = readFileSync(claudeMd, "utf-8");
    expect(content).toContain("CLAUDE.md — Agent Operating Protocol");
    expect(content).toContain("AGENTS.md");
    expect(content).toContain("AGENT.md");
    expect(content).toContain("Working on code repositories");
  });

  it("creates workspace/AGENTS.md and workspace/AGENT.md as symlinks to CLAUDE.md", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("claudemd-symlinks", config, tmpDir, telegramConfig);

    const agentsMd = join(result.agentDir, "workspace", "AGENTS.md");
    const agentMd = join(result.agentDir, "workspace", "AGENT.md");

    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(lstatSync(agentMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(readlinkSync(agentMd)).toBe("CLAUDE.md");
  });

  it("content read via AGENTS.md, AGENT.md, and CLAUDE.md is identical", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("claudemd-identity", config, tmpDir, telegramConfig);

    const viaClaude = readFileSync(join(result.agentDir, "workspace", "CLAUDE.md"), "utf-8");
    const viaAgents = readFileSync(join(result.agentDir, "workspace", "AGENTS.md"), "utf-8");
    const viaAgent = readFileSync(join(result.agentDir, "workspace", "AGENT.md"), "utf-8");
    expect(viaAgents).toBe(viaClaude);
    expect(viaAgent).toBe(viaClaude);
  });

  it("migrates a legacy regular-file workspace/AGENTS.md into CLAUDE.md on reconcile", () => {
    // Simulate a pre-Phase-5 agent: scaffold first, then replace the
    // post-Phase-5 layout with the legacy shape (regular-file AGENTS.md,
    // no CLAUDE.md, no AGENT.md symlink). Then reconcile and verify the
    // migration preserved the legacy content under the new filename.
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "legacy-agent": config },
    } as SwitchroomConfig;

    const result = scaffoldAgent("legacy-agent", config, tmpDir, telegramConfig, switchroomConfig);
    const workspaceDir = join(result.agentDir, "workspace");

    // Unwind Phase-5 layout → legacy state
    rmSync(join(workspaceDir, "AGENT.md"), { force: true });
    rmSync(join(workspaceDir, "AGENTS.md"), { force: true });
    const legacyContent = "# Pre-Phase-5 AGENTS.md\n\nAgent-specific customization that must survive.\n";
    writeFileSync(join(workspaceDir, "AGENTS.md"), legacyContent, "utf-8");
    rmSync(join(workspaceDir, "CLAUDE.md"), { force: true });

    reconcileAgent("legacy-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const claudeMd = join(workspaceDir, "CLAUDE.md");
    const agentsMd = join(workspaceDir, "AGENTS.md");
    const agentMd = join(workspaceDir, "AGENT.md");

    expect(existsSync(claudeMd)).toBe(true);
    expect(lstatSync(claudeMd).isFile()).toBe(true);
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    // Migrated content preserved (writeIfMissing skipped CLAUDE.md since the
    // migration already created it).
    expect(readFileSync(claudeMd, "utf-8")).toBe(legacyContent);

    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(lstatSync(agentMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentMd)).toBe("CLAUDE.md");
  });

  it("is idempotent — reconcile twice leaves symlinks unchanged", () => {
    const config = makeAgentConfig();
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { "idem-claudemd": config },
    } as SwitchroomConfig;

    scaffoldAgent("idem-claudemd", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("idem-claudemd", config, tmpDir, telegramConfig, switchroomConfig);
    reconcileAgent("idem-claudemd", config, tmpDir, telegramConfig, switchroomConfig);

    const agentsMd = join(tmpDir, "idem-claudemd", "workspace", "AGENTS.md");
    const agentMd = join(tmpDir, "idem-claudemd", "workspace", "AGENT.md");
    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(lstatSync(agentMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentMd)).toBe("CLAUDE.md");
  });
});

describe("renderProfileClaudeTemplate — scaffold wires it correctly", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-profile-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders profiles/<name>/CLAUDE.md from CLAUDE.md.hbs after scaffolding", () => {
    // Set up a temp profiles root with a minimal profile.
    const profilesRoot = join(tmpDir, "profiles");
    const profileDir = join(profilesRoot, "testprofile");
    mkdirSync(profileDir, { recursive: true });

    // Write a simple .hbs template — uses the `profile` variable that
    // renderProfileClaudeTemplate passes into the Handlebars context.
    const hbsContent = "# Profile: {{profile}}\n\nHello from the template.\n";
    writeFileSync(join(profileDir, "CLAUDE.md.hbs"), hbsContent, "utf-8");

    // Call renderProfileClaudeTemplate directly with the temp root — this is
    // exactly what scaffoldAgent invokes (without the override the real
    // PROFILES_ROOT would be used; with override we stay in the temp dir).
    const result = renderProfileClaudeTemplate("testprofile", profilesRoot);

    // The function must report that it wrote the file.
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(join(profileDir, "CLAUDE.md"));

    // The output file must exist and contain the rendered content.
    expect(existsSync(result.path)).toBe(true);
    const rendered = readFileSync(result.path, "utf-8");
    expect(rendered).toContain("# Profile: testprofile");
    expect(rendered).toContain("Hello from the template.");
  });

  it("returns wrote:false when profile has no CLAUDE.md.hbs", () => {
    const profilesRoot = join(tmpDir, "profiles");
    const profileDir = join(profilesRoot, "nohbs");
    mkdirSync(profileDir, { recursive: true });
    // No .hbs file — function should be a no-op.

    const result = renderProfileClaudeTemplate("nohbs", profilesRoot);

    expect(result.wrote).toBe(false);
    expect(existsSync(join(profileDir, "CLAUDE.md"))).toBe(false);
  });
});

/**
 * Footgun G — scaffold↔reconcile permission-allow PARITY (golden output).
 *
 * The create engine (scaffoldAgent) and the reconcile engine
 * (reconcileAgentInner) used to inline byte-identical copies of the
 * allow-list computation, kept "in lockstep" only by a comment — the exact
 * drift footgun. PR4 extracts the computation into the single shared
 * computeDesiredPermissionAllow. These tests pin the OUTCOME the extraction
 * guarantees: for representative configs, reconcile writes the SAME
 * permissions.allow that scaffold did (no drift, no churn), and both equal
 * the shared helper's output. A regression that re-diverges the two engines
 * fails here, not silently in production.
 */
describe("footgun G — scaffold↔reconcile permission-allow parity", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-parity-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function allowAfterScaffoldThenReconcile(
    name: string,
    config: AgentConfig,
    switchroomConfig: SwitchroomConfig,
  ): { afterScaffold: string[]; afterReconcile: string[]; afterSecondReconcile: string[] } {
    const settingsPath = join(tmpDir, name, ".claude", "settings.json");
    scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const afterScaffold = JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow;
    reconcileAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const afterReconcile = JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow;
    reconcileAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const afterSecondReconcile = JSON.parse(readFileSync(settingsPath, "utf-8")).permissions.allow;
    return { afterScaffold, afterReconcile, afterSecondReconcile };
  }

  // `hindsight` toggles the memory backend so isHindsightEnabled() flips —
  // exercising BOTH the enabled and disabled paths of the shared helper
  // (review #8: the disabled path was never run before).
  const cases: Array<{ label: string; config: AgentConfig; hindsight: boolean }> = [
    { label: "default (no tools)", config: makeAgentConfig({}), hindsight: true },
    { label: "dangerous_mode: true", config: makeAgentConfig({ dangerous_mode: true } as Partial<AgentConfig>), hindsight: true },
    { label: "tools.allow: [all]", config: makeAgentConfig({ tools: { allow: ["all"], deny: [] } } as Partial<AgentConfig>), hindsight: true },
    {
      label: "explicit tools.allow",
      config: makeAgentConfig({ tools: { allow: ["Read", "Grep", "custom-tool"], deny: [] } } as Partial<AgentConfig>),
      hindsight: true,
    },
    {
      label: "webkite opted out",
      config: makeAgentConfig({ mcp_servers: { webkite: false } } as Partial<AgentConfig>),
      hindsight: true,
    },
    // review #8 — hindsight DISABLED (memory backend none): the helper must
    // omit the hindsight MCP tools, and scaffold≡reconcile must still hold.
    { label: "hindsight disabled (memory backend none)", config: makeAgentConfig({}), hindsight: false },
  ];

  for (const { label, config, hindsight } of cases) {
    it(`reconcile preserves scaffold's allow-list for: ${label}`, () => {
      const name = `parity-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      const switchroomConfig: SwitchroomConfig = {
        switchroom: { version: 1, agents_dir: tmpDir },
        telegram: telegramConfig,
        // memory.backend drives isHindsightEnabled(), which BOTH engines and
        // the helper read identically. "hindsight" enables it; anything else
        // (here: absent) disables it.
        ...(hindsight ? { memory: { backend: "hindsight" } } : {}),
        agents: { [name]: config },
      } as SwitchroomConfig;

      const { afterScaffold, afterReconcile, afterSecondReconcile } =
        allowAfterScaffoldThenReconcile(name, config, switchroomConfig);

      // The load-bearing footgun-G guarantee PR4 delivers: the create engine
      // (scaffold) and the reconcile engine converge to the IDENTICAL final
      // settings.allow SET, driven by the ONE shared helper
      // computeDesiredPermissionAllow. A regression that re-inlines a divergent
      // allow computation in either engine breaks this equality.
      const set = (a: string[]) => [...new Set(a)].sort();
      expect(set(afterReconcile)).toEqual(set(afterScaffold));
      // Idempotent across a second reconcile.
      expect(set(afterSecondReconcile)).toEqual(set(afterReconcile));
      // Every tool the engines write is present in the shared helper computed
      // with the SAME hindsight state — pins the helper as the single source
      // and, on the disabled case, that no hindsight tool leaks in.
      const helper = new Set(computeDesiredPermissionAllow(config, hindsight));
      for (const tool of set(afterReconcile)) expect(helper.has(tool)).toBe(true);
      // On the disabled case, assert no hindsight MCP tool was written at all.
      if (!hindsight) {
        expect(set(afterReconcile).some((t) => t.startsWith("mcp__hindsight"))).toBe(false);
      }
    });
  }

  it("helper: dangerous_mode drops the read-only default seeding", () => {
    const safe = computeDesiredPermissionAllow(makeAgentConfig({}), true);
    const dangerous = computeDesiredPermissionAllow(
      makeAgentConfig({ dangerous_mode: true } as Partial<AgentConfig>),
      true,
    );
    // The safe (no explicit allow) config seeds read-only defaults; dangerous
    // does not. So the safe set must be strictly larger on at least one
    // read-only tool that dangerous omits.
    expect(safe.length).toBeGreaterThan(dangerous.length);
  });

  it("helper: hindsight flag toggles the hindsight MCP tools deterministically", () => {
    const on = computeDesiredPermissionAllow(makeAgentConfig({}), true);
    const off = computeDesiredPermissionAllow(makeAgentConfig({}), false);
    const hindsightOnly = on.filter((t) => !off.includes(t));
    expect(hindsightOnly.length).toBeGreaterThan(0);
    expect(hindsightOnly.every((t) => t.includes("hindsight"))).toBe(true);
  });
});
