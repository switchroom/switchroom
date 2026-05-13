import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, TelegramConfig } from "../src/config/schema.js";

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

    // CLAUDE.md should be significantly smaller without persona block.
    // Cap raised from 12000 → 16000 for vault/hindsight/sub-agent/Telegram
    // additions in v0.3-v0.4; raised again 16000 → 24000 for the
    // lifecycle additions in #557 (wake-audit + restart-visibility);
    // raised again 24000 → 26000 for the phone-first-UX epic #572
    // (`!` interrupt marker, voice transcripts, sticker/GIF persona
    // guidance, Telegraph long-reply auto-publish); cap had already
    // drifted to ~27.3KB on upstream/main from incremental persona /
    // skill / handoff edits before the bump below. Raised again
    // 26000 → 32000 for the unconditional vault-protocol fragment
    // appended to every agent's CLAUDE.md (~2.9KB; teaches the agent
    // when to call vault_request_access, when to degrade gracefully
    // in cron context, and why --no-broker / env-file fallbacks can't
    // work from inside a sandbox — RCA: gymbro silently fell back to
    // estimates on VAULT-BROKER-DENIED instead of requesting a grant).
    // Raised again 32000 → 33000 for PR1 of the voice/architecture
    // cleanup (#1177): unified AI-tells ban-list into SOUL.md "Never"
    // and added a procedural "Execution Bias" section to CLAUDE.md.
    // LOWERED 33000 → 28000 in PR2 of the same cleanup (#TBD):
    // hoisted resume protocol, wake audit, "why did you restart" debug
    // commands, `!` interrupt implementation detail, and "status?"
    // UX-failure signal procedures out of telegram-style.md.hbs into
    // a new bundled `switchroom-runtime` skill. Always-loaded prompt
    // now points at the skill via short triggers; procedural detail
    // loads on demand. ~5KB removed from every-turn context.
    // RAISED 28000 → 32000 for the agent-self-sufficiency epic
    // (#TBD): four new always-loaded blocks the goal explicitly
    // required — (a) "What you are" honest-identity statement +
    // peer-awareness pointer at `peers_list`, (b) admin-vs-non-admin
    // refusal posture so non-admin agents hand off to the right
    // peer instead of trying to run hostd verbs, (c) peers_list +
    // skill_install/skill_remove rows in the self-service fragment.
    // Net adds ~3KB; trimmed otherwise where prose was redundant.
    // The previous 33000 ceiling left effectively no headroom for
    // future fragments, so we step back up to a comparable point.
    // Each block is load-bearing. Future bumps should justify themselves
    // similarly.
    expect(claudeMd.length).toBeLessThan(32000); // post-self-sufficiency epic; identity + peers + admin posture
  });
});
