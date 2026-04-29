/**
 * Tests for the handoff-briefing assembler (bin/handoff-briefing.sh) and
 * the schema default change (resume_mode defaults to 'handoff').
 *
 * These tests cover:
 *   - Schema: resume_mode parsed default is 'handoff'
 *   - scaffold: start.sh template with handoff mode does NOT contain --continue
 *   - scaffold: start.sh template with continue mode DOES contain --continue
 *   - Briefing assembler: combines all three sources, gracefully degrades if any missing
 *   - Briefing assembler: empty-state produces empty briefing rather than crashing
 *   - Migration warning: fires once when auto-detected without explicit setting;
 *                        suppressed after marker file is created
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import { SessionContinuitySchema } from "../src/config/schema.js";

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

// ── Schema default ──────────────────────────────────────────────────────────────

describe("schema: resume_mode default", () => {
  it("SessionContinuitySchema accepts 'handoff' as a valid value", () => {
    const result = SessionContinuitySchema.safeParse({ resume_mode: "handoff" });
    expect(result.success).toBe(true);
  });

  it("SessionContinuitySchema accepts 'auto', 'continue', 'none' for migration", () => {
    for (const mode of ["auto", "continue", "none"] as const) {
      const result = SessionContinuitySchema.safeParse({ resume_mode: mode });
      expect(result.success).toBe(true);
    }
  });

  it("scaffold defaults resume_mode to 'handoff' when not explicitly set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "handoff-schema-"));
    try {
      const result = scaffoldAgent(
        "default-mode-agent",
        makeAgentConfig(),
        tmp,
        telegramConfig,
      );
      const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      expect(startSh).toContain('SWITCHROOM_RESUME_MODE="handoff"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── start.sh mode behaviours ────────────────────────────────────────────────────

describe("scaffold: start.sh resume mode behaviours", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-scaffold-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handoff mode (default) does NOT contain --continue in CONTINUE_FLAG assignment", () => {
    const result = scaffoldAgent(
      "handoff-default",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('SWITCHROOM_RESUME_MODE="handoff"');
    // In handoff/none mode the auto/continue case branches are omitted entirely
    // so CONTINUE_FLAG="--continue" never appears in the rendered script (#377).
    expect(startSh).not.toContain('CONTINUE_FLAG="--continue"');
    expect(startSh).not.toMatch(/case "\$SWITCHROOM_RESUME_MODE" in/);
  });

  it("explicit continue mode DOES pass --continue (regression guard for opt-in)", () => {
    const result = scaffoldAgent(
      "continue-explicit",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('SWITCHROOM_RESUME_MODE="continue"');
    expect(startSh).toContain('CONTINUE_FLAG="--continue"');
  });

  it("explicit auto mode still generates size-check branch and --continue path", () => {
    const result = scaffoldAgent(
      "auto-explicit",
      makeAgentConfig({
        session_continuity: { resume_mode: "auto" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('SWITCHROOM_RESUME_MODE="auto"');
    expect(startSh).toContain('CONTINUE_FLAG="--continue"');
    expect(startSh).toMatch(/SWITCHROOM_RESUME_MAX_BYTES/);
  });

  it("force-fresh (.force-fresh-session) overrides handoff mode and clears CONTINUE_FLAG", () => {
    // The /reset and /new commands write .force-fresh-session, which must
    // override any resume mode including 'continue'. This is a regression guard.
    const result = scaffoldAgent(
      "force-fresh-test",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The force-fresh block must always be present regardless of resume_mode
    expect(startSh).toContain(".force-fresh-session");
    expect(startSh).toContain('CONTINUE_FLAG=""');
    expect(startSh).toContain("_FORCE_FRESH=1");
  });

  it("/new and /reset force fresh session even in continue mode (start.sh structure check)", () => {
    // In continue mode start.sh should still have the .force-fresh-session override
    // block that unconditionally clears CONTINUE_FLAG.
    const result = scaffoldAgent(
      "reset-override-test",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The force-fresh block appears AFTER the resume mode case block
    const caseIdx = startSh.indexOf('case "$SWITCHROOM_RESUME_MODE" in');
    const forceFreshIdx = startSh.indexOf(".force-fresh-session");
    expect(caseIdx).toBeGreaterThan(-1);
    expect(forceFreshIdx).toBeGreaterThan(caseIdx);
    // Force-fresh clears CONTINUE_FLAG unconditionally
    const forceFreshBlock = startSh.slice(forceFreshIdx);
    expect(forceFreshBlock).toContain('CONTINUE_FLAG=""');
  });
});

// ── Briefing assembler script ───────────────────────────────────────────────────

const HANDOFF_BRIEFING_SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "../bin/handoff-briefing.sh",
);

/** Returns today's date as YYYY-MM-DD in local time, matching `date +%Y-%m-%d` in bash. */
function localDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("handoff-briefing.sh assembler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-briefing-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("script exists and is executable", () => {
    expect(existsSync(HANDOFF_BRIEFING_SCRIPT)).toBe(true);
    // Check it's executable by running it with --stdout in empty-state (should produce empty output)
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    // Should exit 0 (empty state = no output = exit 0)
    expect(result.status).toBe(0);
  });

  it("empty state: produces empty briefing and exits 0", () => {
    // No telegram DB, no hindsight, no daily memory — should produce nothing
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: join(tmpDir, "telegram"),
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("");
  });

  it("daily memory: injects today's daily memory file when present", () => {
    // Create a fake daily memory file for today
    const today = localDateString(); // YYYY-MM-DD in local time (matches bash `date +%Y-%m-%d`)
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Worked on handoff feature\n- PR review pending\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("Today's memory");
    expect(output).toContain("Worked on handoff feature");
    expect(output).toContain("PR review pending");
  });

  it("daily memory: skips gracefully when memory dir is absent", () => {
    // No memory/ directory at all
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("");
  });

  it("writes output to .handoff-briefing.md when not in stdout mode", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Daily note for file output test\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const outputFile = join(tmpDir, ".handoff-briefing.md");
    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("Daily note for file output test");
  });

  it("includes restart timestamp header when any source has content", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Some content\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("You just restarted at");
    expect(output).toContain("Previous session ended via:");
  });

  it("hindsight skipped gracefully when API URL is empty", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Hindsight skip test\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "testbank",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    // Should have daily content but no Hindsight section
    expect(output).toContain("Hindsight skip test");
    expect(output).not.toContain("Hindsight recall");
  });

  it("hindsight skipped gracefully when API is unreachable", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Unreachable hindsight test\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        // Point to a non-existent port — should timeout quickly and continue
        HINDSIGHT_API_URL: "http://127.0.0.1:19999",
        HINDSIGHT_BANK_ID: "testbank",
        WORKSPACE_DIR: tmpDir,
        HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT: "1",
      },
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("Unreachable hindsight test");
  });
});

// ── Migration warning ───────────────────────────────────────────────────────────

describe("reconcileAgent: migration warning for auto → handoff default change", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-migration-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMinimalAgentDir(name: string, baseDir: string): string {
    const agentDir = join(baseDir, name);
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    mkdirSync(join(agentDir, "telegram"), { recursive: true });
    mkdirSync(join(agentDir, "memory"), { recursive: true });
    // Write a minimal settings.json so reconcile doesn't error
    writeFileSync(
      join(agentDir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: [], deny: [] },
        hooks: {},
      }),
      "utf-8",
    );
    return agentDir;
  }

  it("migration marker file does not exist before first reconcile", () => {
    const agentDir = makeMinimalAgentDir("warn-agent", tmpDir);
    const markerPath = join(agentDir, ".resume-mode-migration-warned");
    expect(existsSync(markerPath)).toBe(false);
  });

  it("marker file is created after reconcile when no explicit resume_mode", () => {
    const agentName = "warn-agent-2";
    makeMinimalAgentDir(agentName, tmpDir);

    const agentConfig = makeAgentConfig(); // no session_continuity.resume_mode
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    // Capture console.warn to avoid polluting test output
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // reconcile may error on missing files — that's ok for this test
    } finally {
      console.warn = origWarn;
    }

    const markerPath = join(tmpDir, agentName, ".resume-mode-migration-warned");
    expect(existsSync(markerPath)).toBe(true);
  });

  it("migration warning fires when no explicit resume_mode and no marker file", () => {
    const agentName = "warn-agent-3";
    makeMinimalAgentDir(agentName, tmpDir);

    const agentConfig = makeAgentConfig(); // no session_continuity.resume_mode
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // ignore reconcile errors — we only care about the warning
    } finally {
      console.warn = origWarn;
    }

    const warnText = warns.join("\n");
    expect(warnText).toContain("resume_mode default changed");
    expect(warnText).toContain("handoff");
    expect(warnText).toContain("#362");
  });

  it("migration warning is suppressed when marker file already exists", () => {
    const agentName = "warn-agent-4";
    const agentDir = makeMinimalAgentDir(agentName, tmpDir);

    // Pre-create the marker file
    const markerPath = join(agentDir, ".resume-mode-migration-warned");
    writeFileSync(markerPath, "already warned\n", "utf-8");

    const agentConfig = makeAgentConfig(); // no session_continuity.resume_mode
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // ignore reconcile errors
    } finally {
      console.warn = origWarn;
    }

    const warnText = warns.join("\n");
    expect(warnText).not.toContain("resume_mode default changed");
  });

  it("no migration warning when resume_mode is explicitly set in config", () => {
    const agentName = "warn-agent-5";
    makeMinimalAgentDir(agentName, tmpDir);

    const agentConfig = makeAgentConfig({
      session_continuity: { resume_mode: "handoff" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // ignore reconcile errors
    } finally {
      console.warn = origWarn;
    }

    const warnText = warns.join("\n");
    expect(warnText).not.toContain("resume_mode default changed");
  });
});
