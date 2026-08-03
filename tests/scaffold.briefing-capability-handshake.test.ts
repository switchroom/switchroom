import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { GATEWAY_BOOT_BRIEFING_CAPABILITY } from "../telegram-plugin/gateway/boot-briefing-capability.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * #4245 — start.sh ↔ gateway-bundle version-skew handshake.
 *
 * A fresh start.sh with `briefing: gateway` skips the legacy shell handoff
 * assembler; if the deployed gateway bundle predates the boot-briefing builder,
 * the agent gets a silent no-briefing. start.sh's outer pass greps the bundle
 * for the capability sentinel and, on a miss, warns loudly + drops a marker so
 * the inner pass runs the legacy assembler as a fallback.
 */

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeSwitchroomConfig(agentName: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents", skills_dir: "~/.switchroom/skills" },
    telegram: telegramConfig,
    agents: { [agentName]: agentConfig },
  };
}

const GATEWAY_FORK = 'bun "$_gateway_bundle"';

describe("start.sh: gateway boot-briefing version-skew handshake (#4245)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-briefing-cap-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function renderStartSh(briefing?: "gateway" | "legacy"): string {
    const config = {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      ...(briefing ? { session_continuity: { briefing } } : {}),
    } as AgentConfig;
    const sw = makeSwitchroomConfig("test-agent", config);
    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, sw);
    return readFileSync(join(result.agentDir, "start.sh"), "utf-8");
  }

  it("templates the capability sentinel from the single source of truth (no drift)", () => {
    const startSh = renderStartSh("gateway");
    // The literal grepped in start.sh MUST equal the constant the gateway bundle
    // carries — a bump to one without the other silently breaks the handshake.
    expect(startSh).toContain(GATEWAY_BOOT_BRIEFING_CAPABILITY);
    expect(startSh).toContain(`grep -q '${GATEWAY_BOOT_BRIEFING_CAPABILITY}' "$_gateway_bundle"`);
  });

  it("runs the bundle capability grep BEFORE forking the gateway", () => {
    const startSh = renderStartSh("gateway");
    const grepIdx = startSh.indexOf(`grep -q '${GATEWAY_BOOT_BRIEFING_CAPABILITY}'`);
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(grepIdx).toBeGreaterThan(-1);
    expect(forkIdx).toBeGreaterThan(-1);
    expect(grepIdx).toBeLessThan(forkIdx);
  });

  it("on a stale bundle: warns loudly and drops the fallback marker", () => {
    const startSh = renderStartSh("gateway");
    // Guarded on the requested mode so a legacy agent pays nothing.
    expect(startSh).toContain('if [ "$SWITCHROOM_SESSION_BRIEFING" = "gateway" ]; then');
    expect(startSh).toMatch(/WARNING: session_continuity\.briefing=gateway is configured/);
    expect(startSh).toContain('touch "$_briefing_skew_marker"');
    // Marker is resolved afresh each boot (rm first) so an image update self-heals.
    expect(startSh).toContain('rm -f "$_briefing_skew_marker"');
    expect(startSh).toContain('.gateway-briefing-unavailable');
  });

  it("inner-pass legacy assembler runs as a fallback when the skew marker is present", () => {
    const startSh = renderStartSh("gateway");
    // The gate keeps its `!= gateway` skip but ORs in the marker so a
    // skew-detected boot still gets the legacy briefing.
    expect(startSh).toContain('[ -f "');
    expect(startSh).toMatch(/\|\| \[ -f "[^"]*\.gateway-briefing-unavailable" \]/);
  });

  it("the handshake block is present regardless of mode, gated on the runtime env (legacy pays nothing)", () => {
    const startSh = renderStartSh("legacy");
    // The block renders unconditionally but its body is gated on
    // SWITCHROOM_SESSION_BRIEFING=gateway at runtime, so a legacy agent skips it.
    expect(startSh).toContain('if [ "$SWITCHROOM_SESSION_BRIEFING" = "gateway" ]; then');
  });
});
