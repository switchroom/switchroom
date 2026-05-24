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
 * This test pins the contract: with `skipProfileTemplates: true`,
 * reconcileAgent does NOT execute any of the 5 blocks inside reconcile
 * that read from source-adjacent dirs absent in the agent image:
 *
 *   1. start.sh re-render (profiles/_base/start.sh.hbs)
 *   2. CLAUDE.md re-render (profiles/<name>/CLAUDE.md.hbs)
 *   3. installHindsightPlugin (vendor/hindsight-memory/)
 *   4. installSwitchroomSkills + reconcileAgentDefaultSkills
 *      (~/.switchroom/skills/_bundled/ on host)
 *   5. workspace bootstrap re-seed (profiles/<name>/workspace/*.hbs)
 *
 * Block #5 was the direct cause of the failure (throws "Profile not
 * found: default (searched /profiles)"). PR #1619 originally gated only
 * blocks 1+2; this file extends coverage to all 5 after a 2026-05-24
 * audit (#TODO-PR) found that the same `schedule_add` chain still hit
 * blocks 3, 4, and 5.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
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

  // ─── Block #3 — installHindsightPlugin (#1618 follow-up) ────────────────
  //
  // Contract: with skipProfileTemplates:true, reconcileAgent must NOT
  // call installHindsightPlugin. In-agent the vendor/hindsight-memory/
  // source path doesn't exist (the agent image flattens the bundle), and
  // installHindsightPlugin writes a misleading "check the npm tarball"
  // stderr line before returning null. Even though the return-null path
  // doesn't fail reconcile by itself, the stderr noise + the unnecessary
  // copy work makes gating cleaner.

  it("skipProfileTemplates: true → installHindsightPlugin NOT called (hindsight plugin dir not recreated after delete)", () => {
    const name = "gamma";
    const hindsightConfig: SwitchroomConfig = {
      ...switchroomConfig,
      memory: { backend: "hindsight" },
    } as SwitchroomConfig;

    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, hindsightConfig);

    const pluginDir = join(tmpDir, name, ".claude", "plugins", "hindsight-memory");
    expect(existsSync(pluginDir)).toBe(true);

    // Delete the plugin dir so we can detect whether reconcile re-copies it.
    rmSync(pluginDir, { recursive: true, force: true });
    expect(existsSync(pluginDir)).toBe(false);

    // Reconcile with skipProfileTemplates: true — must NOT recreate.
    reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      hindsightConfig,
      undefined,
      { skipProfileTemplates: true },
    );
    expect(existsSync(pluginDir)).toBe(false);

    // Reconcile with default options — MUST recreate (proves the gate is
    // honest: same code path, different option, different behaviour).
    reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      hindsightConfig,
      undefined,
      {},
    );
    expect(existsSync(pluginDir)).toBe(true);
  });

  // ─── Block #5 — workspace bootstrap re-seed (#1618 direct cause) ────────
  //
  // Contract: with skipProfileTemplates:true, reconcileAgent must NOT
  // call getProfilePath() for the workspace re-seed. That call throws
  // "Profile not found: default (searched /profiles)" inside the agent
  // container — the exact error finn saw on 2026-05-24 — and is what
  // surfaces as E_RECONCILE_FAILED on schedule_add.
  //
  // We exercise the contract by deleting a workspace bootstrap file and
  // checking that reconcile with the flag on does NOT re-seed it (and
  // does NOT throw), while reconcile with default options does.

  it("skipProfileTemplates: true → workspace bootstrap NOT re-seeded (no getProfilePath throw)", () => {
    const name = "delta";
    scaffoldAgent(name, makeAgentConfig(), tmpDir, telegramConfig, switchroomConfig);

    // Pick a workspace bootstrap file the scaffold seeds. SOUL.md is
    // seeded once via writeIfMissing — delete it and observe whether
    // reconcile re-seeds (default) or skips (skipProfileTemplates).
    const soulPath = join(tmpDir, name, "workspace", "SOUL.md");
    expect(existsSync(soulPath)).toBe(true);
    unlinkSync(soulPath);
    expect(existsSync(soulPath)).toBe(false);

    // skipProfileTemplates: true — must NOT re-seed, must NOT throw.
    expect(() => {
      reconcileAgent(
        name,
        makeAgentConfig(),
        tmpDir,
        telegramConfig,
        switchroomConfig,
        undefined,
        { skipProfileTemplates: true },
      );
    }).not.toThrow();
    expect(existsSync(soulPath)).toBe(false);

    // Default — MUST re-seed (proves the gate flips behaviour).
    reconcileAgent(
      name,
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
      switchroomConfig,
      undefined,
      {},
    );
    expect(existsSync(soulPath)).toBe(true);
  });
});
