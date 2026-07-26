import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, TelegramConfig } from "../src/config/schema.js";
// @ts-expect-error — plain .mjs guard module, shared with the ratchet unit test.
import {
  evaluateRatchet,
  readRatchet,
  readMainRatchet,
} from "../scripts/check-claude-md-byte-ratchet.mjs";

/** Repo root, so the ratchet file resolves regardless of vitest's cwd. */
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

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

describe("scaffoldAgent — persona (Phase 2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-persona-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits workspace/SOUL.md with rendered persona content", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        emoji: "💪",
        style: "motivational, direct",
        boundaries: "not a doctor",
        expertise: "fitness and nutrition",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");

    expect(existsSync(workspaceSoulPath)).toBe(true);
    const soulMd = readFileSync(workspaceSoulPath, "utf-8");

    // Verify persona structure
    expect(soulMd).toContain("# Coach");
    expect(soulMd).toContain("💪");
    expect(soulMd).toContain("motivational, direct");
    expect(soulMd).toContain("not a doctor");
    expect(soulMd).toContain("fitness and nutrition");
  });

  it("creates symlink from <agentDir>/SOUL.md → workspace/SOUL.md", () => {
    const config = makeAgentConfig({
      soul: { name: "Test", style: "concise" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const agentSoulPath = join(result.agentDir, "SOUL.md");
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");

    expect(existsSync(agentSoulPath)).toBe(true);
    expect(existsSync(workspaceSoulPath)).toBe(true);

    const stat = lstatSync(agentSoulPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = readlinkSync(agentSoulPath);
    expect(target).toBe("workspace/SOUL.md");
  });

  it("CLAUDE.md references SOUL.md instead of containing persona block", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    // Should reference SOUL.md
    expect(claudeMd).toContain("SOUL.md");
    expect(claudeMd).toContain("persona source of truth");

    // Should NOT contain persona block
    expect(claudeMd).not.toContain("## Persona");
    expect(claudeMd).not.toContain("You are **Coach**");
    expect(claudeMd).not.toContain("motivational");
  });

  it("CLAUDE.md is slim (target <16KB)", () => {
    const config = makeAgentConfig({
      soul: {
        name: "Coach",
        style: "motivational, direct, no fluff",
        boundaries: "not a doctor, not a therapist, stay in lane",
        expertise: "fitness, nutrition, habit formation, accountability",
      },
    });

    const result = scaffoldAgent("health-coach", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");

    // Byte ceiling for a SMALL profile. The number is not a magic
    // constant: it is the checked-in RATCHET in
    // scripts/claude-md-byte-ratchet.txt, which may only ever be LOWERED.
    // autoTighten is off here because this small-profile stack legitimately
    // sits far below the worst-case ceiling the ratchet tracks; the
    // worst-case test below is what keeps the ratchet honest.
    const { ok, errors } = evaluateRatchet({
      actual: claudeMd.length,
      ratchet: readRatchet(REPO_ROOT),
      autoTighten: false,
    });
    expect(errors.join("\n")).toBe("");
    expect(ok).toBe(true);
  });

  it("worst-case stack (root-tier + default profile) obeys the byte RATCHET — raising it is not the remedy", () => {
    // The worst case is a root-tier agent on the DEFAULT profile: the full
    // admin surface PLUS the root-tier host-access block on top of the largest
    // profile body. That is the stack scripts/claude-md-byte-ratchet.txt
    // tracks, so this test enforces all three ratchet rules:
    //
    //   INFLATION    — the prompt may not grow past the ceiling.
    //   AUTO-TIGHTEN — a PR that SHRINKS the prompt must record the new,
    //                  lower ceiling in the same PR, so it can never silently
    //                  re-inflate to an old high-water mark.
    //   NEVER-RAISE  — a PR may lower the ratchet, never raise it.
    //
    // History is why this is a ratchet and no longer a bare number: the old
    // ceiling went 26000 → 32000 → 33000 → (28000) → 32000 → 33500 → 37500 →
    // 40000, because "raise the ceiling" was always the cheapest way past a
    // breach. It is no longer available. If this test reds with INFLATION,
    // the fix is to move procedure into an on-demand skill, push tool usage
    // into the tool description, or delete a rule that duplicates another —
    // NOT to edit the ratchet file upward.
    const config = makeAgentConfig({ root: true } as Partial<AgentConfig>);
    const result = scaffoldAgent("overlord", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");
    const { ok, errors } = evaluateRatchet({
      actual: claudeMd.length,
      ratchet: readRatchet(REPO_ROOT),
      mainRatchet: readMainRatchet(REPO_ROOT),
    });
    expect(errors.join("\n")).toBe("");
    expect(ok).toBe(true);
  });

  it("root: true renders the root-tier host-access block + the admin surface", () => {
    const config = makeAgentConfig({ root: true } as Partial<AgentConfig>);
    const result = scaffoldAgent("overlord", config, tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("Root-tier host access");
    expect(claudeMd).toContain("/host"); // host root fs mount documented
    expect(claudeMd).toContain("/host-home/.switchroom/");
    // root implies admin → the admin surface renders too (not the
    // non-admin hand-off branch).
    expect(claudeMd).toContain("## Admin surface");
    expect(claudeMd).not.toContain("You're NOT `admin: true`");
    // Accuracy pins (the root agent runs as uid 0; these claims were
    // verified against the live container AND against source):
    // 1. The root block composes with the admin approval-card section BY
    //    PATH, not by rank. It must NOT claim to supersede it: root: true
    //    forces admin semantics on, so the hostd MCP server IS wired for a
    //    root agent (src/agents/scaffold.ts gates on `admin === true ||
    //    root === true`; src/agents/compose.ts mounts the hostd socket for
    //    every agent and hostd gates server-side in checkGate). The old
    //    "supersedes / those verbs aren't wired into your container" text
    //    was factually wrong and would have made a root agent skip real
    //    tools it has. What IS true: the agent's OWN shell (docker, /host,
    //    /host-home) is un-tapped, while hostd verbs still block on an
    //    operator approval card.
    expect(claudeMd).not.toContain("supersedes the \"Admin surface\" section");
    expect(claudeMd).toContain("How this composes with the Admin surface above — by path, not by rank");
    expect(claudeMd).toContain("standing and un-tapped");
    expect(claudeMd).toContain("still wired for you and still gated");
    // 2. Correct host-side per-agent log path (NOT the in-container
    //    /var/log/switchroom path, which doesn't exist under /host).
    expect(claudeMd).toContain("/host-home/.switchroom/logs/<agent>/");
    expect(claudeMd).not.toContain("/host/var/log/switchroom/");
    // 3. No claim that a full `switchroom apply` runs from the container
    //    (compose dir isn't mounted) — it's flagged as a host operation.
    expect(claudeMd).toContain("hand the `apply` to the operator");
  });

  it("a non-root agent never renders the root-tier block", () => {
    const result = scaffoldAgent("plain", makeAgentConfig(), tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("Root-tier host access");
  });
});
