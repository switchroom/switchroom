import { describe, it, expect } from "vitest";
import {
  generateUnit,
  generateGatewayUnit,
  cronToOnCalendar,
  generateTimerUnit,
  generateTimerServiceUnit,
  resolveGatewayUnitName,
} from "../src/agents/systemd.js";
import { usesSwitchroomTelegramPlugin } from "../src/config/merge.js";
import type { AgentConfig, SwitchroomConfig } from "../src/config/schema.js";

function makeConfig(agents: Record<string, AgentConfig>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents", skills_dir: "~/.switchroom/skills" },
    telegram: { bot_token: "vault:telegram-bot-token" },
    defaults: {},
    agents,
  } as unknown as SwitchroomConfig;
}

describe("generateUnit", () => {
  it("generates valid unit file content", () => {
    const unit = generateUnit("health-coach", "/home/user/.switchroom/agents/health-coach");

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("sets the correct Description", () => {
    const unit = generateUnit("health-coach", "/home/user/.switchroom/agents/health-coach");
    expect(unit).toContain("Description=switchroom agent: health-coach");
  });

  it("uses script -qfc for PTY provision", () => {
    const unit = generateUnit("health-coach", "/home/user/.switchroom/agents/health-coach");
    expect(unit).toContain("ExecStart=/usr/bin/script -qfc");
    expect(unit).toContain("/home/user/.switchroom/agents/health-coach/start.sh");
  });

  it("logs to service.log in agent dir", () => {
    const unit = generateUnit("health-coach", "/home/user/.switchroom/agents/health-coach");
    expect(unit).toContain("/home/user/.switchroom/agents/health-coach/service.log");
  });

  it("sets the correct WorkingDirectory", () => {
    const unit = generateUnit("health-coach", "/home/user/.switchroom/agents/health-coach");
    expect(unit).toContain("WorkingDirectory=/home/user/.switchroom/agents/health-coach");
  });

  it("handles agent names with hyphens correctly", () => {
    const unit = generateUnit("my-cool-agent", "/agents/my-cool-agent");
    expect(unit).toContain("Description=switchroom agent: my-cool-agent");
    expect(unit).toContain("/agents/my-cool-agent/start.sh");
    expect(unit).toContain("WorkingDirectory=/agents/my-cool-agent");
  });

  it("includes network dependency targets", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
  });

  it("configures restart on failure", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("StartLimitIntervalSec=120");
  });

  it("places StartLimitBurst and StartLimitIntervalSec in [Unit] section, not [Service]", () => {
    const unit = generateUnit("test", "/tmp/test");
    const unitSection = unit.split("[Service]")[0];
    const serviceSection = unit.split("[Service]")[1].split("[Install]")[0];
    expect(unitSection).toContain("StartLimitBurst=5");
    expect(unitSection).toContain("StartLimitIntervalSec=120");
    expect(serviceSection).not.toContain("StartLimitBurst");
    expect(serviceSection).not.toContain("StartLimitIntervalSec");
  });

  it("sets Type=simple for script-based execution", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("Type=simple");
  });

  it("includes journal output", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
  });

  it("targets default.target for user units", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("uses expect autoaccept wrapper when useAutoaccept=true", () => {
    const unit = generateUnit("fork", "/tmp/fork", true);
    expect(unit).toContain("/usr/bin/expect");
    expect(unit).toContain("autoaccept.exp");
    expect(unit).toContain("/tmp/fork/start.sh");
    // Should NOT reference the old Python autoaccept script
    expect(unit).not.toContain("autoaccept.py");
    expect(unit).not.toContain("/usr/bin/python3");
  });

  it("does not use expect wrapper by default", () => {
    const unit = generateUnit("plain", "/tmp/plain", false);
    expect(unit).not.toContain("autoaccept.exp");
    expect(unit).not.toContain("/usr/bin/expect");
    expect(unit).toContain("/bin/bash");
  });
});

describe("cronToOnCalendar", () => {
  it("converts a simple daily cron", () => {
    expect(cronToOnCalendar("0 8 * * *")).toBe("*-*-* 08:00:00");
  });

  it("converts weekday range", () => {
    expect(cronToOnCalendar("0 8 * * 1-5")).toBe("Mon..Fri *-*-* 08:00:00");
  });

  it("converts comma-separated days of week", () => {
    // cron: 0=Sunday, 6=Saturday → Sun,Sat in systemd order
    expect(cronToOnCalendar("30 9 * * 0,6")).toBe("Sun,Sat *-*-* 09:30:00");
  });

  it("converts minute step value", () => {
    const result = cronToOnCalendar("*/15 * * * *");
    expect(result).toBe("*-*-* *:00/15:00");
  });

  it("converts hour step value", () => {
    const result = cronToOnCalendar("0 */2 * * *");
    expect(result).toBe("*-*-* 00/2:00:00");
  });

  it("pads single-digit minute and hour", () => {
    expect(cronToOnCalendar("5 9 * * *")).toBe("*-*-* 09:05:00");
  });

  it("throws on invalid cron with wrong number of fields", () => {
    expect(() => cronToOnCalendar("0 8 * *")).toThrow("expected 5 fields");
    expect(() => cronToOnCalendar("0 8 * * * *")).toThrow("expected 5 fields");
  });
});

describe("generateTimerUnit", () => {
  it("generates a valid timer with OnCalendar", () => {
    const timer = generateTimerUnit("coach", 0, "0 8 * * *", "Morning check-in");
    expect(timer).toContain("[Timer]");
    expect(timer).toContain("OnCalendar=*-*-* 08:00:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("coach #0");
    expect(timer).toContain("Morning check-in");
  });

  it("truncates long prompts in the description", () => {
    const longPrompt = "A".repeat(100);
    const timer = generateTimerUnit("agent", 0, "0 9 * * *", longPrompt);
    expect(timer).toContain("...");
    expect(timer.length).toBeLessThan(timer.length + 100);
  });
});

describe("generateTimerServiceUnit", () => {
  it("generates a oneshot service pointing at the cron script", () => {
    const service = generateTimerServiceUnit("coach", 0, "/home/user/.switchroom/agents/coach");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("cron-0.sh");
    expect(service).toContain("WorkingDirectory=/home/user/.switchroom/agents/coach");
  });

  it("uses the correct index in the script path", () => {
    const service = generateTimerServiceUnit("agent", 3, "/tmp/agents/agent");
    expect(service).toContain("cron-3.sh");
  });
});

describe("generateGatewayUnit", () => {
  it("generates valid systemd unit for gateway", () => {
    const unit = generateGatewayUnit("/home/user/.claude/channels/telegram", "assistant");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Description=switchroom telegram gateway");
  });

  it("uses Restart=always with fast restart interval", () => {
    const unit = generateGatewayUnit("/tmp/telegram", "assistant");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=3");
  });

  it("sets TELEGRAM_STATE_DIR environment", () => {
    const unit = generateGatewayUnit("/home/user/.claude/channels/telegram", "assistant");
    expect(unit).toContain("Environment=TELEGRAM_STATE_DIR=/home/user/.claude/channels/telegram");
  });

  it("references gateway entry point", () => {
    const unit = generateGatewayUnit("/tmp/telegram", "assistant");
    expect(unit).toContain("gateway/gateway.ts");
  });

  it("includes rate limiting", () => {
    const unit = generateGatewayUnit("/tmp/telegram", "assistant");
    expect(unit).toContain("StartLimitBurst=10");
    expect(unit).toContain("StartLimitIntervalSec=60");
  });

  it("places StartLimitBurst and StartLimitIntervalSec in [Unit] section, not [Service]", () => {
    const unit = generateGatewayUnit("/tmp/telegram", "assistant");
    const unitSection = unit.split("[Service]")[0];
    const serviceSection = unit.split("[Service]")[1].split("[Install]")[0];
    expect(unitSection).toContain("StartLimitBurst=10");
    expect(unitSection).toContain("StartLimitIntervalSec=60");
    expect(serviceSection).not.toContain("StartLimitBurst");
    expect(serviceSection).not.toContain("StartLimitIntervalSec");
  });

  // Regression test for the "/restart silently does nothing" bug.
  //
  // The gateway's getMyAgentName() prefers process.env.SWITCHROOM_AGENT_NAME
  // and falls back to basename(cwd). Systemd sets WorkingDirectory to
  // `.../<agent>/telegram`, so without the env var every self-restart,
  // /reconcile, /update etc. resolves the agent as "telegram" and the
  // switchroom CLI exits non-zero — no agent named "telegram" exists
  // in switchroom.yaml — with no user-facing error (spawnDetached).
  it("sets SWITCHROOM_AGENT_NAME so gateway self-targeting works", () => {
    const unit = generateGatewayUnit("/tmp/telegram", "clerk");
    expect(unit).toContain("Environment=SWITCHROOM_AGENT_NAME=clerk");
  });

  it("each agent's gateway unit carries its own SWITCHROOM_AGENT_NAME", () => {
    const clerkUnit = generateGatewayUnit("/tmp/clerk/telegram", "clerk");
    const lawgptUnit = generateGatewayUnit("/tmp/lawgpt/telegram", "lawgpt");
    expect(clerkUnit).toContain("Environment=SWITCHROOM_AGENT_NAME=clerk");
    expect(lawgptUnit).toContain("Environment=SWITCHROOM_AGENT_NAME=lawgpt");
    expect(clerkUnit).not.toContain("SWITCHROOM_AGENT_NAME=lawgpt");
    expect(lawgptUnit).not.toContain("SWITCHROOM_AGENT_NAME=clerk");
  });
});

describe("generateUnit with gateway dependency", () => {
  it("adds gateway After dependency when useAutoaccept is true", () => {
    const unit = generateUnit("agent", "/tmp/agent", true);
    expect(unit).toContain("After=network-online.target switchroom-gateway.service");
  });

  it("does not add gateway dependency when useAutoaccept is false", () => {
    const unit = generateUnit("agent", "/tmp/agent", false);
    expect(unit).toContain("After=network-online.target");
    expect(unit).not.toContain("switchroom-gateway.service");
  });

  it("points After= at the agent's own gateway when given an explicit name", () => {
    const unit = generateUnit("lawgpt", "/tmp/lawgpt", true, "lawgpt-gateway");
    expect(unit).toContain("After=network-online.target switchroom-lawgpt-gateway.service");
  });
});

describe("multi-agent gateway support", () => {
  // Regression test for: installAllUnits used to pick the first
  // telegram-using agent and install exactly one gateway for the whole
  // deployment. Every subsequent telegram agent ended up with its own
  // bot token in a state dir no gateway was watching, so Telegram
  // polling silently never started. switchroom is meant to run many
  // agents side-by-side — each with its own bot — so every telegram-
  // using agent must get its own dedicated gateway unit.

  it("resolveGatewayUnitName returns per-agent gateway names", () => {
    const config = makeConfig({
      clerk: { profile: "default" } as AgentConfig,
      lawgpt: { profile: "default" } as AgentConfig,
    });
    expect(resolveGatewayUnitName(config, "clerk")).toBe("clerk-gateway");
    expect(resolveGatewayUnitName(config, "lawgpt")).toBe("lawgpt-gateway");
  });

  it("resolveGatewayUnitName returns undefined for agents that don't use the switchroom telegram plugin", () => {
    const config = makeConfig({
      official: {
        profile: "default",
        channels: { telegram: { plugin: "official" } },
      } as AgentConfig,
    });
    expect(resolveGatewayUnitName(config, "official")).toBeUndefined();
  });

  it("resolveGatewayUnitName returns undefined for an unknown agent", () => {
    const config = makeConfig({
      clerk: { profile: "default" } as AgentConfig,
    });
    expect(resolveGatewayUnitName(config, "ghost")).toBeUndefined();
  });

  it("distinct telegram agents produce distinct gateway unit bodies", () => {
    const clerkUnit = generateGatewayUnit("/home/user/.switchroom/agents/clerk/telegram", "clerk");
    const lawgptUnit = generateGatewayUnit("/home/user/.switchroom/agents/lawgpt/telegram", "lawgpt");

    expect(clerkUnit).toContain("Description=switchroom telegram gateway (clerk)");
    expect(lawgptUnit).toContain("Description=switchroom telegram gateway (lawgpt)");

    expect(clerkUnit).toContain("TELEGRAM_STATE_DIR=/home/user/.switchroom/agents/clerk/telegram");
    expect(lawgptUnit).toContain("TELEGRAM_STATE_DIR=/home/user/.switchroom/agents/lawgpt/telegram");

    expect(clerkUnit).not.toContain("lawgpt");
    expect(lawgptUnit).not.toContain("clerk");
  });

  it("each agent unit After= references its own gateway, not a shared one", () => {
    const clerkUnit = generateUnit("clerk", "/tmp/clerk", true, "clerk-gateway");
    const lawgptUnit = generateUnit("lawgpt", "/tmp/lawgpt", true, "lawgpt-gateway");

    expect(clerkUnit).toContain("After=network-online.target switchroom-clerk-gateway.service");
    expect(lawgptUnit).toContain("After=network-online.target switchroom-lawgpt-gateway.service");

    expect(clerkUnit).not.toContain("switchroom-lawgpt-gateway.service");
    expect(lawgptUnit).not.toContain("switchroom-clerk-gateway.service");
  });
});

describe("autoaccept detection via usesSwitchroomTelegramPlugin", () => {
  it("enables autoaccept when plugin is undefined (default)", () => {
    const agent = { profile: "default" } as AgentConfig;
    expect(usesSwitchroomTelegramPlugin(agent)).toBe(true);
  });

  it("enables autoaccept when plugin is explicitly 'switchroom'", () => {
    const agent = { profile: "default", channels: { telegram: { plugin: "switchroom" } } } as AgentConfig;
    expect(usesSwitchroomTelegramPlugin(agent)).toBe(true);
  });

  it("enables autoaccept when channels exists but telegram is undefined", () => {
    const agent = { profile: "default", channels: {} } as AgentConfig;
    expect(usesSwitchroomTelegramPlugin(agent)).toBe(true);
  });

  it("disables autoaccept when plugin is 'official'", () => {
    const agent = { profile: "default", channels: { telegram: { plugin: "official" } } } as AgentConfig;
    expect(usesSwitchroomTelegramPlugin(agent)).toBe(false);
  });

  it("produces correct systemd unit for each case", () => {
    const defaultAgent = { profile: "default" } as AgentConfig;
    const officialAgent = { profile: "default", channels: { telegram: { plugin: "official" } } } as AgentConfig;

    const autoUnit = generateUnit("dev", "/tmp/dev", usesSwitchroomTelegramPlugin(defaultAgent));
    expect(autoUnit).toContain("autoaccept.exp");
    expect(autoUnit).toContain("/usr/bin/expect");

    const plainUnit = generateUnit("plain", "/tmp/plain", usesSwitchroomTelegramPlugin(officialAgent));
    expect(plainUnit).not.toContain("autoaccept.exp");
    expect(plainUnit).toContain("/bin/bash");
  });
});
