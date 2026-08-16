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

/**
 * Collapse whitespace so an assertion pins the CLAIM, not the current line
 * breaks. The profile templates hard-wrap at ~78 cols, so a rewrap alone
 * used to turn these pins red — and worse, silently satisfy the
 * `not.toContain` leak guards below (a vacuous pass). Normalising both
 * sides keeps the guard honest in both directions.
 */
function flat(md: string): string {
  return md.replace(/\s+/g, " ");
}

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
    expect(flat(claudeMd)).not.toContain("supersedes the \"Admin surface\" section");
    // The CLAIM, not the sentence: the agent's own shell is standing and
    // un-tapped, while the hostd verbs remain wired AND operator-gated.
    expect(flat(claudeMd)).toMatch(/standing (and )?un-tapped/);
    expect(flat(claudeMd)).toMatch(/`hostd`[^.]*still[^.]*(gated|card)/);
    expect(flat(claudeMd)).toContain("prefer your own shell");
    expect(flat(claudeMd)).toContain("`root: true` forces admin semantics");
    // 2. Correct host-side per-agent log path (NOT the in-container
    //    /var/log/switchroom path, which doesn't exist under /host).
    expect(claudeMd).toContain("/host-home/.switchroom/logs/<agent>/");
    expect(claudeMd).not.toContain("/host/var/log/switchroom/");
    // 3. No claim that a full `switchroom apply` runs from the container
    //    (compose dir isn't mounted) — it's flagged as a host operation.
    expect(flat(claudeMd)).toMatch(/`switchroom apply`[^.]*operator|hand the `apply` to the operator/);
    // 4. The "test before you claim a limit" reflex renders for a root
    //    agent: the fleet Sandbox primer tells EVERY agent "read-only /
    //    not root / operator action", but compose.ts emits `user: "0:0"`
    //    and skips read_only/cap_drop for root agents, so that framing is
    //    factually wrong for THIS tier. The reflex tells the root agent to
    //    TEST via its root shell before asserting a limit.
    expect(flat(claudeMd)).toMatch(/Test before you claim a limit|Test limits live/);
    expect(flat(claudeMd)).toContain("never assert \"operator-only\"");
    // 5. The no-exfil carve-out explicitly covers a peer's env via
    //    `docker exec`/`docker inspect` — the reflex sends the agent to
    //    inspect peers, and `docker inspect` PRINTS injected secret values,
    //    so "just testing" must not become a secret-exfil loophole.
    expect(flat(claudeMd)).toContain('"just testing" is no exception');
    expect(flat(claudeMd)).toMatch(/`docker exec`\/(`)?inspect|docker inspect/);
    expect(flat(claudeMd)).toContain("credentials/*.env");
    expect(flat(claudeMd)).toMatch(/prints injected secrets/i);
  });

  it("a non-root agent never renders the root-tier block (reflex must not leak)", () => {
    const result = scaffoldAgent("plain", makeAgentConfig(), tmpDir, telegramConfig);
    const claudeMd = readFileSync(join(result.agentDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("Root-tier host access");
    // The "try docker / /host" reflex would be actively wrong for a
    // non-root agent (no host socket, read-only rootfs), so it must be
    // gated to the root block and never reach a non-root agent.
    // Normalised, so a rewrap of the root block can't make these guards
    // pass vacuously.
    expect(flat(claudeMd)).not.toMatch(/Test before you claim a limit|Test limits live/);
    expect(flat(claudeMd)).not.toContain('"just testing" is no exception');
    expect(flat(claudeMd)).not.toContain("/host-home/.switchroom/");
  });
});
