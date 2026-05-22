/**
 * Regression: switchroom #1618 — `mcp__agent-config__schedule_add` from
 * inside an agent container failed with
 *   E_RECONCILE_FAILED: ENOENT '/profiles/_base/start.sh.hbs'
 * because the agent image (docker/Dockerfile.agent) ships
 * `/opt/switchroom/switchroom.js` without the `profiles/` sibling, so
 * `resolve(import.meta.dirname, "../../profiles")` resolves to `/profiles`
 * which doesn't exist. The cron-only reconcile bridge has no business
 * re-rendering start.sh / CLAUDE.md anyway — it now passes
 * `skipProfileTemplates: true`.
 *
 * This test pins that contract: with `skipProfileTemplates: true`,
 * reconcileAgent does NOT touch start.sh / CLAUDE.md and does NOT throw
 * when the profile template files are unreachable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
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
  } as AgentConfig;
}

describe("reconcileAgent — skipProfileTemplates (#1618)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-skip-profile-tmpl-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skipProfileTemplates: true → start.sh NOT re-rendered, no ENOENT on missing templates", () => {
    const name = "alpha";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const startShPath = join(tmpDir, name, "start.sh");
    const claudeMdPath = join(tmpDir, name, "CLAUDE.md");
    expect(existsSync(startShPath)).toBe(true);

    // Capture mtimes before reconcile.
    const startShMtimeBefore = statSync(startShPath).mtimeMs;
    const claudeMdMtimeBefore = existsSync(claudeMdPath) ? statSync(claudeMdPath).mtimeMs : 0;

    // Wait a tick so any rewrite would observably change mtime.
    const sleepUntil = Date.now() + 15;
    while (Date.now() < sleepUntil) { /* spin */ }

    // Now call reconcileAgent with skipProfileTemplates: true. Even if the
    // bundled `profiles/` tree were missing at runtime (simulating the
    // agent-image case), this must not throw.
    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      { skipProfileTemplates: true },
    );

    // start.sh must not be touched.
    expect(statSync(startShPath).mtimeMs).toBe(startShMtimeBefore);
    expect(result.changes).not.toContain(startShPath);
    // CLAUDE.md must not be touched.
    if (existsSync(claudeMdPath)) {
      expect(statSync(claudeMdPath).mtimeMs).toBe(claudeMdMtimeBefore);
      expect(result.changes).not.toContain(claudeMdPath);
    }
  });

  it("default (skipProfileTemplates omitted) → start.sh re-rendered as before", () => {
    const name = "beta";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    const startShPath = join(tmpDir, name, "start.sh");
    expect(existsSync(startShPath)).toBe(true);

    // Tamper with start.sh so the rendered template differs.
    writeFileSync(startShPath, "# stale\n", "utf-8");

    const result = reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      {},
    );

    // Default path regenerates start.sh from the template.
    expect(result.changes).toContain(startShPath);
    expect(readFileSync(startShPath, "utf-8")).not.toBe("# stale\n");
  });
});
